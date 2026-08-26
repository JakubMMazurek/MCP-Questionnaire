/**
 * One Durable Object per form (§3 "Document mode").
 *
 * Why a DO and not KV: the pattern is per-entity and write-heavy, and draft
 * writes (from the app, via `save_draft`) arrive on a different route from the
 * agent's reads (`load_form`, `get_form_state`). KV's last-write-wins with up
 * to ~60s propagation could prefill a chained form from a stale draft; a DO
 * routes every request for one id to one instance, so writes serialise and
 * reads are strongly consistent.
 *
 * Why SQLite and not one JSON blob: answers are ROWS keyed by path, so
 * autosave rewrites the paths that changed instead of the whole map.
 *
 * Why an alarm: the form self-expires after 30 days idle, the clock resetting
 * on any read or write. With compatibility_date ≥ 2026-02-24 the handler is a
 * single `deleteAll()` — it deletes the active alarm too, so there is no
 * deleteAlarm() to forget.
 *
 * Nothing here logs a payload (§3). See ../src/log.ts.
 */

import { DurableObject } from "cloudflare:workers";
import type { Answers, Form } from "@mcpq/schema";
import type { WorkerEnv } from "./env.js";
import { logEvent } from "./log.js";

/** §3 — "the DO caps answer-payload size". */
export const MAX_DRAFT_BYTES = 256 * 1024;
/** §3 — "and throttles per-form write rate". */
export const MIN_DRAFT_INTERVAL_MS = 1_000;
/** §3 — 30 days idle, the clock resetting on any read or write. */
export const IDLE_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

export type FormState = {
  /** The envelope as stored, `formId` already stamped in. */
  form: Form;
  /** Path → answer. Rows, reassembled. */
  answers: Answers;
  createdAt: number;
  updatedAt: number;
  /**
   * When the user pressed submit, or null while the form is still a draft.
   *
   * The distinction is the whole reason the agent-visible read tool can be
   * trusted: "these are the answers" and "these are the answers so far" are
   * different claims, and only the app knows which one it is holding.
   */
  submittedAt: number | null;
  /** §10 audit attribution — the GitHub login of the LAST writer, or null. */
  updatedBy: string | null;
};

export type SaveDraftInput = {
  answers: Answers;
  /**
   * Whether `answers` is the WHOLE answer map for the rendered view.
   *
   * Default `false` — an incremental autosave. Present paths are upserted;
   * absent paths are left alone. This is the safe default: a truncated or
   * partial payload can never delete state the user still has on screen.
   *
   * `true` declares the payload authoritative, and paths absent from it are
   * deleted. Only a client that builds the map from the full rendered view may
   * set it. In practice the renderer never needs to: §4.6's "not rendered =
   * empty" means a cleared answer is `{ state: "empty" }` — a value present in
   * the map, not a missing key — so rows are updated in place and the delete
   * branch exists for schema changes (a re-render whose rows no longer exist)
   * rather than for ordinary editing.
   */
  complete?: boolean;
  /**
   * §10 audit attribution — the authenticated GitHub login behind this write,
   * when there is one. Optional because the DO must not care: it is called
   * directly by tests, and a write with no identity is a legitimate state, not
   * an error. Absent leaves the previous writer in place rather than blanking
   * it, so the column always answers "who last touched this", never "who last
   * touched this while authenticated".
   */
  updatedBy?: string | null;
  /**
   * Set once, by the submit flush: this payload is what the user submitted.
   *
   * Only ever written to `true` — a submitted form that the user then edits is
   * still a submitted form with newer answers, and the timestamp says which is
   * which. Implies `complete`, and the caller sets both.
   */
  submitted?: boolean;
};

export type SaveDraftResult =
  | { ok: true; saved: number; deleted: number; updatedAt: number }
  | { ok: false; code: "no_form"; message: string }
  | { ok: false; code: "too_large"; message: string; bytes: number; limit: number }
  | { ok: false; code: "throttled"; message: string; retryAfterMs: number };

/**
 * The RPC surface as the Worker uses it.
 *
 * Durable Object stubs constrain RPC returns to `Rpc.Serializable`, and an
 * answer's `value` is `unknown` by design (§4.3 — the value is agent-declared
 * and the server never interprets it). `unknown` does not satisfy that
 * constraint, so `stub.getState()` infers as `never` even though every value
 * that ever crosses the wire is plain JSON. This interface is the narrow,
 * single place where that gap is bridged; see `formStore` in mcp-server.ts.
 */
export type FormStore = {
  exists(): Promise<boolean>;
  getState(): Promise<FormState | null>;
  init(form: Form, updatedBy?: string | null): Promise<{ createdAt: number }>;
  saveDraft(input: SaveDraftInput): Promise<SaveDraftResult>;
};

type FormRow = {
  schema: string;
  version: number;
  createdAt: number;
  updatedAt: number;
  updatedBy: string | null;
  submittedAt: number | null;
  lastDraftAt: number;
};
type AnswerRow = { path: string; state: string; value: string | null; note: string | null };

export class FormDO extends DurableObject<WorkerEnv> {
  /* ------------------------------- lifecycle ------------------------------ */

  /**
   * Created by `init` and NOT by the constructor, deliberately.
   *
   * A DO instance outlives its storage: `alarm()` calls `deleteAll()`, which
   * drops these tables, and the instance stays in memory to serve whatever
   * arrives next. Creating the tables in the constructor therefore does not
   * help — the instance that survives the wipe already ran its constructor —
   * and re-creating them after the wipe would leave every expired form holding
   * an empty schema forever, which is exactly the billed storage the TTL exists
   * to release.
   *
   * So the tables exist only while a form does, and every read tolerates their
   * absence (`#hasTables`). An expired form then behaves from the outside
   * exactly like an id that was never used, which is the correct answer.
   */
  #createTables(): void {
    // Synchronous on the SQLite backend, so no blockConcurrencyWhile needed.
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS form (
        id          INTEGER PRIMARY KEY CHECK (id = 1),
        schema      TEXT    NOT NULL,
        version     INTEGER NOT NULL,
        createdAt   INTEGER NOT NULL,
        updatedAt   INTEGER NOT NULL,
        -- Separate from updatedAt so that stamping the schema in (init) never
        -- throttles the view's first autosave.
        lastDraftAt INTEGER NOT NULL DEFAULT 0,
        -- §10 audit attribution (build step 7): the GitHub login of the last
        -- writer. Nullable because a write can legitimately have no identity.
        updatedBy   TEXT,
        -- Null until the user submits. Read by the agent-visible answer tool,
        -- which must not present a half-filled draft as a decision.
        submittedAt INTEGER
      );
      CREATE TABLE IF NOT EXISTS answers (
        path  TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        value TEXT,
        note  TEXT
      );
    `);
  }

  #hasTables(): boolean {
    const row = this.ctx.storage.sql
      .exec<{ n: number }>(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('form', 'answers')",
      )
      .one();
    return row.n === 2;
  }

  /**
   * Brings a form table created before build step 7 up to the current shape.
   *
   * `CREATE TABLE IF NOT EXISTS` is a no-op on an object that already has the
   * table, so a column added to the DDL above never reaches a form that
   * already exists — and every SELECT naming `updatedBy` would then throw on
   * exactly the forms someone is still using. One `PRAGMA` per read is a
   * trivially cheap price for that not happening.
   *
   * Only ever called when `#hasTables()` is true.
   */
  #migrate(): void {
    const columns = this.ctx.storage.sql
      .exec<{ name: string }>("PRAGMA table_info(form)")
      .toArray();
    if (!columns.some((column) => column.name === "updatedBy")) {
      this.ctx.storage.sql.exec("ALTER TABLE form ADD COLUMN updatedBy TEXT");
    }
    if (!columns.some((column) => column.name === "submittedAt")) {
      this.ctx.storage.sql.exec("ALTER TABLE form ADD COLUMN submittedAt INTEGER");
    }
  }

  /**
   * Resets the 30-day idle clock. Called by EVERY method, read or write —
   * "clock resets on any read or write" (§3).
   */
  async #touch(now: number): Promise<void> {
    await this.ctx.storage.setAlarm(now + IDLE_TTL_MS);
  }

  /**
   * The TTL handler. One call: with compatibility_date ≥ 2026-02-24
   * `deleteAll()` also deletes the active alarm, so this cannot leave a
   * rescheduled alarm behind on an emptied object.
   */
  override async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
    logEvent({ event: "form_expired" });
  }

  /* --------------------------------- reads -------------------------------- */

  #readForm(): FormRow | null {
    // Never initialised, or expired and wiped. Both are "no form".
    if (!this.#hasTables()) return null;
    this.#migrate();
    const rows = this.ctx.storage.sql
      .exec<FormRow>(
        "SELECT schema, version, createdAt, updatedAt, lastDraftAt, updatedBy, submittedAt FROM form WHERE id = 1",
      )
      .toArray();
    return rows[0] ?? null;
  }

  #readAnswers(): Answers {
    const rows = this.ctx.storage.sql
      .exec<AnswerRow>("SELECT path, state, value, note FROM answers")
      .toArray();
    const answers: Answers = {};
    for (const row of rows) {
      answers[row.path] =
        row.state === "answered"
          ? {
              state: "answered",
              value: row.value === null ? null : JSON.parse(row.value),
              ...(row.note === null ? {} : { note: row.note }),
            }
          : { state: "empty", ...(row.note === null ? {} : { note: row.note }) };
    }
    return answers;
  }

  /** Cheap existence probe — `load_form` needs it before it renders anything. */
  async exists(): Promise<boolean> {
    return this.#readForm() !== null;
  }

  /** §3 — what a re-opened form hydrates from. */
  async getState(): Promise<FormState | null> {
    const row = this.#readForm();
    if (!row) return null;
    const state: FormState = {
      form: JSON.parse(row.schema) as Form,
      answers: this.#readAnswers(),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      submittedAt: row.submittedAt ?? null,
      updatedBy: row.updatedBy ?? null,
    };
    await this.#touch(Date.now());
    return state;
  }

  /* --------------------------------- writes ------------------------------- */

  /**
   * Creates the form, or replaces its schema on a re-render of the same id.
   *
   * Answers are deliberately kept across a re-init: forms are documents (§10),
   * and a chained/edited schema over the same id should not silently discard
   * what the user already answered. Paths the new schema no longer has are
   * simply never resolved — the renderer is the view, and §4.6's "not rendered
   * = empty" makes stale rows inert.
   */
  async init(form: Form, updatedBy: string | null = null): Promise<{ createdAt: number }> {
    const now = Date.now();
    const existing = this.#readForm();
    this.#createTables();
    const createdAt = existing?.createdAt ?? now;
    this.ctx.storage.sql.exec(
      `INSERT INTO form (id, schema, version, createdAt, updatedAt, updatedBy) VALUES (1, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET schema = excluded.schema, version = excluded.version,
                                     updatedAt = excluded.updatedAt,
                                     -- COALESCE, not assignment: a write with no
                                     -- identity must not erase the last known one.
                                     updatedBy = COALESCE(excluded.updatedBy, form.updatedBy)`,
      JSON.stringify(form),
      form.version,
      createdAt,
      now,
      updatedBy,
    );
    await this.#touch(now);
    // Counted, never named (§3): the login is data at rest in the row above,
    // and it stays out of retained observability logs.
    logEvent({ event: "form_init", count: form.sections.length });
    return { createdAt };
  }

  /**
   * Autosave. Upserts one row per path (§3), enforcing the two hardening rules
   * that make a leaked id un-spammable: a payload size cap and a per-form
   * minimum write interval. Both are enforced HERE rather than in the tool
   * handler, because the DO is the only thing that serialises writes for an id
   * — a rate limit in a stateless request handler limits nothing.
   */
  async saveDraft(input: SaveDraftInput): Promise<SaveDraftResult> {
    const row = this.#readForm();
    if (!row) {
      return {
        ok: false,
        code: "no_form",
        message: "no form is stored under this id — it may have expired (30-day idle TTL).",
      };
    }

    const serialised = JSON.stringify(input.answers ?? {});
    const bytes = new TextEncoder().encode(serialised).length;
    if (bytes > MAX_DRAFT_BYTES) {
      logEvent({ event: "draft_rejected", code: "too_large", bytes });
      return {
        ok: false,
        code: "too_large",
        message: `draft is ${bytes} bytes; the per-write cap is 256 KiB (${MAX_DRAFT_BYTES} bytes). Nothing was saved.`,
        bytes,
        limit: MAX_DRAFT_BYTES,
      };
    }

    const now = Date.now();
    const since = now - row.lastDraftAt;
    /**
     * The FIRST submit skips the rate limit, and only that one.
     *
     * The limit exists to make a leaked id un-spammable and to absorb autosave
     * chatter — neither describes the submit write, which happens once, on a
     * user gesture, and is the write the agent is about to be told to read.
     * Throttling it means the receipt can reach the conversation before the
     * answers reach the store, and the agent reads a form that looks unfinished.
     *
     * Bounded by `submittedAt IS NULL`, so the exemption is worth exactly one
     * extra write per form for the lifetime of the form. Later submits (the
     * user edited something and submitted again) queue like anything else, and
     * the app preserves the flag across the retry.
     */
    const firstSubmit = input.submitted === true && row.submittedAt === null;
    if (since < MIN_DRAFT_INTERVAL_MS && !firstSubmit) {
      const retryAfterMs = MIN_DRAFT_INTERVAL_MS - since;
      logEvent({ event: "draft_rejected", code: "throttled", ms: retryAfterMs });
      return {
        ok: false,
        code: "throttled",
        message: `too many writes for this form; retry in ${retryAfterMs}ms (minimum interval ${MIN_DRAFT_INTERVAL_MS}ms).`,
        retryAfterMs,
      };
    }

    const paths = Object.keys(input.answers ?? {});
    for (const path of paths) {
      const answer = input.answers[path];
      if (!answer) continue;
      const value = answer.state === "answered" ? JSON.stringify(answer.value ?? null) : null;
      this.ctx.storage.sql.exec(
        `INSERT INTO answers (path, state, value, note) VALUES (?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET state = excluded.state, value = excluded.value,
                                         note = excluded.note`,
        path,
        answer.state,
        value,
        answer.note ?? null,
      );
    }

    let deleted = 0;
    if (input.complete === true) {
      const keep = new Set(paths);
      const stale = this.ctx.storage.sql
        .exec<{ path: string }>("SELECT path FROM answers")
        .toArray()
        .filter((r) => !keep.has(r.path));
      for (const r of stale) {
        this.ctx.storage.sql.exec("DELETE FROM answers WHERE path = ?", r.path);
      }
      deleted = stale.length;
    }

    this.ctx.storage.sql.exec(
      // COALESCE for the same reason as `init`: no identity leaves the last
      // known writer in place rather than blanking the column. `submittedAt`
      // takes the FIRST submit and keeps it — later edits move `updatedAt`.
      `UPDATE form SET updatedAt = ?, lastDraftAt = ?, updatedBy = COALESCE(?, updatedBy),
                       submittedAt = COALESCE(submittedAt, ?) WHERE id = 1`,
      now,
      now,
      input.updatedBy ?? null,
      input.submitted === true ? now : null,
    );
    await this.#touch(now);
    logEvent({ event: "draft_saved", count: paths.length });
    return { ok: true, saved: paths.length, deleted, updatedAt: now };
  }
}
