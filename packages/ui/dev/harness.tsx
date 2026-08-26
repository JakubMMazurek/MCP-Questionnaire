/**
 * The dev harness: a host, played over the same transport the real one uses.
 *
 * `pnpm --filter @mcpq/ui dev` then open http://localhost:5173/dev/. The app
 * runs in a real iframe and talks real postMessage JSON-RPC, so what this page
 * exercises is the actual bridge — the handshake, the tool-input notifications,
 * the debounced pushes, cancellation and teardown. Everything is local: the
 * harness runs with no network at all, which is the same constraint the bundle
 * itself lives under (§8).
 *
 * Not part of the production build (vite.config.ts pins the input to
 * index.html).
 */

import { archetypes } from "@mcpq/schema";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  createFakeHost,
  type FakeHost,
  type HostContext,
  METHOD,
  type Seen,
  windowTransport,
} from "../src/host/index.js";

type FixtureKey = keyof typeof archetypes;
type Theme = "light" | "dark";
type Mode = "inline" | "fullscreen";
type Platform = "web" | "mobile";

const FIXTURES: { key: FixtureKey; label: string }[] = [
  { key: "assumptionLedger", label: "§5.1 assumption ledger" },
  { key: "elicitation", label: "§5.2 elicitation" },
  { key: "convergence", label: "§5.3 convergence — prune" },
  { key: "convergenceRank", label: "§5.3/§5.6 convergence — chained rank" },
  { key: "planConfirmation", label: "§5.4 plan confirmation" },
  { key: "matrixFls", label: "§5.5 matrix (FLS)" },
];

/**
 * A palette deliberately unlike the bundle's own `:root` fallbacks, so it is
 * obvious at a glance whether host variables are actually driving the surface
 * (§7.4). Toggle "send palette" off to see the fallbacks.
 */
const PALETTE: Record<Theme, Record<string, string>> = {
  light: {
    "--color-background-primary": "#fdfcfa",
    "--color-background-secondary": "#f4f1ec",
    "--color-background-tertiary": "#eae5dc",
    "--color-background-inverse": "#20201d",
    "--color-background-warning": "#fbf0dc",
    "--color-background-info": "#e6eefb",
    "--color-background-success": "#e6f2e8",
    "--color-text-primary": "#20201d",
    "--color-text-secondary": "#6b6659",
    "--color-text-tertiary": "#918b7d",
    "--color-text-inverse": "#fdfcfa",
    "--color-text-warning": "#8a5a12",
    "--color-text-info": "#2f5da8",
    "--color-text-success": "#2f6b3f",
    "--color-border-primary": "#ddd6c9",
    "--color-border-secondary": "#e9e3d8",
    "--color-ring-primary": "#c96442",
    "--border-radius-sm": "8px",
    "--border-radius-full": "999px",
  },
  dark: {
    "--color-background-primary": "#1f1e1c",
    "--color-background-secondary": "#171614",
    "--color-background-tertiary": "#2a2825",
    "--color-background-inverse": "#efece5",
    "--color-background-warning": "#332b1a",
    "--color-background-info": "#1c2735",
    "--color-background-success": "#1b2b21",
    "--color-text-primary": "#efece5",
    "--color-text-secondary": "#a39d90",
    "--color-text-tertiary": "#847e72",
    "--color-text-inverse": "#1f1e1c",
    "--color-text-warning": "#d9a94e",
    "--color-text-info": "#8fb2e0",
    "--color-text-success": "#7cc188",
    "--color-border-primary": "#3a3733",
    "--color-border-secondary": "#2d2a26",
    "--color-ring-primary": "#c96442",
    "--border-radius-sm": "8px",
    "--border-radius-full": "999px",
  },
};

/** Prefixes of a streaming schema, so `tool-input-partial` can be exercised. */
function partials(form: unknown): unknown[] {
  const full = structuredClone(form) as {
    version: number;
    title: string;
    description?: string;
    sections: { fields: unknown[] }[];
    rules?: unknown[];
    prefill?: Record<string, unknown>;
  };
  const headOnly = { version: full.version, title: full.title, description: full.description };
  const firstSection = structuredClone(full);
  firstSection.sections = [full.sections[0] as { fields: unknown[] }];
  return [headOnly, firstSection, full];
}

type LogEntry = { at: string; direction: "in" | "out"; method: string; detail: string };

function summarise(params: unknown): string {
  if (params === undefined) return "";
  const text = JSON.stringify(params);
  return text.length > 220 ? `${text.slice(0, 220)}…` : text;
}

const styles = {
  page: {
    display: "grid",
    gridTemplateColumns: "340px minmax(0, 1fr)",
    height: "100vh",
    margin: 0,
    fontFamily: "ui-sans-serif, system-ui, sans-serif",
    fontSize: "13px",
    color: "#1b2320",
    background: "#eef0ec",
  },
  panel: {
    display: "flex",
    flexDirection: "column",
    gap: "10px",
    padding: "14px",
    borderRight: "1px solid #d5dad3",
    background: "#f7f8f6",
    overflow: "auto",
  },
  group: { display: "flex", flexWrap: "wrap", gap: "6px" } as const,
  label: {
    fontSize: "11px",
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    color: "#6a746e",
  } as const,
  button: {
    padding: "5px 9px",
    border: "1px solid #cfd5cd",
    borderRadius: "6px",
    background: "#fff",
    font: "inherit",
    cursor: "pointer",
  } as const,
  active: { background: "#1b2320", border: "1px solid #1b2320", color: "#fff" } as const,
  log: {
    flex: 1,
    minHeight: "200px",
    overflow: "auto",
    padding: "8px",
    border: "1px solid #d5dad3",
    borderRadius: "6px",
    background: "#fff",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: "11px",
    lineHeight: 1.45,
  } as const,
  stage: { display: "flex", flexDirection: "column", padding: "18px", overflow: "auto" } as const,
} as const;

function Harness() {
  const [fixture, setFixture] = useState<FixtureKey>("assumptionLedger");
  const [theme, setTheme] = useState<Theme>("light");
  const [mode, setMode] = useState<Mode>("fullscreen");
  const [platform, setPlatform] = useState<Platform>("web");
  const [sendPalette, setSendPalette] = useState(true);
  const [draftFails, setDraftFails] = useState(false);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [generation, setGeneration] = useState(0);

  const frame = useRef<HTMLIFrameElement | null>(null);
  const host = useRef<FakeHost | null>(null);
  const settings = useRef({ theme, mode, platform, sendPalette, draftFails, fixture });
  settings.current = { theme, mode, platform, sendPalette, draftFails, fixture };

  const append = useCallback(
    (entry: Omit<LogEntry, "at">) =>
      setLog((entries) =>
        [{ at: new Date().toLocaleTimeString(), ...entry }, ...entries].slice(0, 120),
      ),
    [],
  );

  const context = useCallback((): HostContext => {
    const current = settings.current;
    return {
      theme: current.theme,
      displayMode: current.mode,
      availableDisplayModes: ["inline", "fullscreen"],
      ...(current.sendPalette ? { styles: { variables: PALETTE[current.theme] } } : {}),
      safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
      platform: current.platform,
      locale: "en-GB",
      timeZone: "Europe/London",
      deviceCapabilities:
        current.platform === "mobile"
          ? { touch: true, hover: false }
          : { touch: false, hover: true },
    };
  }, []);

  const transport = useMemo(
    () => windowTransport({ target: () => frame.current?.contentWindow ?? null }),
    [],
  );

  const sendSchema = useCallback(
    (key: FixtureKey) => {
      host.current?.sendToolInput(archetypes[key]);
      append({ direction: "out", method: METHOD.toolInput, detail: key });
      // The stub result, exactly as the Worker returns it (§3). This is the ONLY
      // channel by which the app learns the server-minted formId, so without it
      // every save_draft in the harness would carry `formId: null`.
      const formId = `f_${key.toLowerCase()}_demo`;
      host.current?.sendToolResult({
        content: [{ type: "text", text: `Form displayed; awaiting input. formId: ${formId}` }],
        structuredContent: { formId },
      });
      append({ direction: "out", method: METHOD.toolResult, detail: formId });
    },
    [append],
  );

  const pushContext = useCallback(
    (patch: HostContext) => {
      host.current?.sendContextChange(patch);
      append({ direction: "out", method: METHOD.hostContextChanged, detail: summarise(patch) });
    },
    [append],
  );

  // One host for the life of the page; the iframe may reload under it.
  useEffect(() => {
    host.current = createFakeHost({
      transport,
      hostContext: context,
      onToolsCall: () =>
        settings.current.draftFails ? new Error("save_draft is not deployed yet") : { ok: true },
      onRequest: (request) => {
        if (request.method === METHOD.requestDisplayMode) {
          const wanted = (request.params as { mode?: Mode }).mode ?? "inline";
          setMode(wanted);
          return { mode: wanted };
        }
        return undefined;
      },
      onSeen: (entry: Seen) => {
        if (entry.method === METHOD.sizeChanged) {
          setSize(entry.params as { width: number; height: number });
        }
        if (entry.method === METHOD.initialized) {
          // The host MUST NOT send tool notifications before this (§7.2).
          queueMicrotask(() => sendSchema(settings.current.fixture));
        }
        append({ direction: "in", method: entry.method, detail: summarise(entry.params) });
      },
    });
    return () => host.current?.stop();
  }, [transport, append, context, sendSchema]);

  const stream = async (key: FixtureKey) => {
    const steps = partials(archetypes[key]);
    for (const [index, step] of steps.entries()) {
      if (index === steps.length - 1) {
        host.current?.sendToolInput(step);
        append({ direction: "out", method: METHOD.toolInput, detail: `${key} (complete)` });
      } else {
        host.current?.sendPartial(step);
        append({
          direction: "out",
          method: METHOD.toolInputPartial,
          detail: `${key} #${index + 1}`,
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
  };

  useEffect(() => {
    // Theme, palette and display mode are host state: push them as a patch.
    pushContext({
      theme,
      displayMode: mode,
      platform,
      ...(sendPalette ? { styles: { variables: PALETTE[theme] } } : {}),
    });
  }, [theme, mode, platform, sendPalette, pushContext]);

  const toggle = (on: boolean) => ({ ...styles.button, ...(on ? styles.active : {}) });

  return (
    <div style={styles.page}>
      <div style={styles.panel}>
        <div>
          <strong>host harness</strong>
          <div style={{ color: "#6a746e" }}>io.modelcontextprotocol/ui · 2026-01-26</div>
        </div>

        <div>
          <div style={styles.label}>fixture</div>
          <div style={{ ...styles.group, flexDirection: "column" }}>
            {FIXTURES.map((entry) => (
              <button
                key={entry.key}
                type="button"
                style={toggle(entry.key === fixture)}
                onClick={() => {
                  setFixture(entry.key);
                  sendSchema(entry.key);
                }}
              >
                {entry.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <div style={styles.label}>theme</div>
          <div style={styles.group}>
            <button
              type="button"
              style={toggle(theme === "light")}
              onClick={() => setTheme("light")}
            >
              light
            </button>
            <button type="button" style={toggle(theme === "dark")} onClick={() => setTheme("dark")}>
              dark
            </button>
            <button
              type="button"
              style={toggle(sendPalette)}
              onClick={() => setSendPalette((value) => !value)}
              title="Send hostContext.styles.variables, or leave the bundle on its :root fallbacks"
            >
              send palette
            </button>
          </div>
        </div>

        <div>
          <div style={styles.label}>display mode</div>
          <div style={styles.group}>
            <button
              type="button"
              style={toggle(mode === "inline")}
              onClick={() => setMode("inline")}
            >
              inline
            </button>
            <button
              type="button"
              style={toggle(mode === "fullscreen")}
              onClick={() => setMode("fullscreen")}
            >
              fullscreen
            </button>
          </div>
        </div>

        <div>
          <div style={styles.label}>platform</div>
          <div style={styles.group}>
            <button
              type="button"
              style={toggle(platform === "web")}
              onClick={() => setPlatform("web")}
            >
              web
            </button>
            <button
              type="button"
              style={toggle(platform === "mobile")}
              onClick={() => setPlatform("mobile")}
              title="§7.3 — a dense matrix becomes a read-only summary list"
            >
              mobile
            </button>
          </div>
        </div>

        <div>
          <div style={styles.label}>lifecycle</div>
          <div style={styles.group}>
            <button type="button" style={styles.button} onClick={() => void stream(fixture)}>
              stream partials
            </button>
            <button
              type="button"
              style={styles.button}
              onClick={() => {
                host.current?.sendCancelled("the user pressed stop");
                append({ direction: "out", method: METHOD.toolCancelled, detail: "" });
              }}
            >
              cancel
            </button>
            <button
              type="button"
              style={styles.button}
              onClick={() => {
                append({ direction: "out", method: METHOD.teardown, detail: "waiting for flush" });
                void host.current?.teardown().then(() =>
                  append({
                    direction: "in",
                    method: `${METHOD.teardown} (answered)`,
                    detail: "",
                  }),
                );
              }}
            >
              teardown
            </button>
            <button
              type="button"
              style={toggle(draftFails)}
              onClick={() => setDraftFails((value) => !value)}
              title="Reject save_draft, as an undeployed Worker would"
            >
              save_draft fails
            </button>
            <button
              type="button"
              style={styles.button}
              onClick={() => setGeneration((value) => value + 1)}
            >
              reload app
            </button>
          </div>
        </div>

        <div>
          <div style={styles.label}>
            messages from the app{size ? ` · ${size.width}×${size.height}` : ""}
          </div>
        </div>
        <div style={styles.log}>
          {log.map((entry) => (
            <div
              key={`${entry.at}-${entry.method}-${entry.detail}`}
              style={{ marginBottom: "4px" }}
            >
              <span style={{ color: entry.direction === "in" ? "#2f5da8" : "#8a5a12" }}>
                {entry.direction === "in" ? "◀" : "▶"} {entry.method}
              </span>
              {entry.detail ? <div style={{ color: "#6a746e" }}>{entry.detail}</div> : null}
            </div>
          ))}
        </div>
      </div>

      <div style={styles.stage}>
        <div style={{ ...styles.label, marginBottom: "6px" }}>
          {mode === "inline" ? "inline card (auto-fit height)" : "fullscreen surface"}
        </div>
        <iframe
          key={generation}
          ref={frame}
          title="MCP Questionnaire renderer"
          src="/index.html"
          style={{
            width: mode === "inline" ? "min(560px, 100%)" : "100%",
            height: mode === "inline" ? `${Math.max(size?.height ?? 160, 120)}px` : "100%",
            minHeight: mode === "inline" ? "120px" : "600px",
            border: "1px solid #d5dad3",
            borderRadius: "12px",
            background: "#fff",
          }}
        />
      </div>
    </div>
  );
}

const container = document.getElementById("harness");
if (container) createRoot(container).render(<Harness />);
