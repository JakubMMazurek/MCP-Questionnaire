/**
 * The only logging permitted in this Worker (§3 — "No logging of payloads").
 *
 * Document mode means answers DO rest in the form's Durable Object, so the
 * privacy story is precise rather than absolute: stored only under the
 * unguessable id, NEVER logged, self-expiring via alarm. Observability is on in
 * wrangler.jsonc, which means anything handed to `console.*` is retained — so
 * the ban has to be mechanical, not a good intention.
 *
 * `logEvent` takes a closed field set. There is no `data`, no `payload`, no
 * `unknown` escape hatch: an answer map, a note, a field label or a form schema
 * has nowhere to go. Diagnostics text is a product surface for the AGENT
 * (§6.3), not for the log — it quotes the author's own labels and paths, so it
 * is counted, never printed.
 *
 * There is no `formId` field either, deliberately. The id IS the capability
 * (§3): form state at rest is reachable by anyone who knows it, so putting ids
 * into retained logs would hand out the keys to make the log useful. Which
 * form a line refers to is not knowable from the logs, and that is correct.
 */

export type LogFields = {
  /** Which code path. */
  event: string;
  /** Byte size of a rejected/accepted payload. A number, not the payload. */
  bytes?: number;
  /** How many answer rows / diagnostics / whatever was counted. */
  count?: number;
  /** A closed-vocabulary reason, never free text derived from input. */
  code?: string;
  /** Elapsed milliseconds. */
  ms?: number;
};

export function logEvent(fields: LogFields): void {
  console.log(JSON.stringify(fields));
}

/** Operator-facing configuration problems. Never carries request data. */
export function logConfigError(message: string): void {
  console.error(JSON.stringify({ event: "config_error", code: message }));
}
