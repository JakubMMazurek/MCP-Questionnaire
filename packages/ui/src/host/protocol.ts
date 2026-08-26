/**
 * MCP Apps wire protocol — extension `io.modelcontextprotocol/ui`, revision
 * 2026-01-26 (SEP-1865, Stable).
 *
 * Method names and shapes verified against
 * modelcontextprotocol/ext-apps `specification/2026-01-26/apps.mdx` on
 * 2026-08-26 rather than from memory (CLAUDE.md, currency rule). Notable
 * details that are easy to get wrong and are load-bearing here:
 *  - `ui/resource-teardown` is a REQUEST: the host waits for our response, so
 *    the final draft flush can complete before the view is torn down.
 *  - `ui/update-model-context` and `ui/message` are requests too (result `{}`),
 *    not notifications.
 *  - JSON-RPC objects are posted to the parent frame with no envelope.
 *  - The host must not send tool notifications before it has seen
 *    `ui/notifications/initialized`.
 */

export const PROTOCOL_VERSION = "2026-01-26";

export const APP_INFO = { name: "mcp-questionnaire-renderer", version: "0.1.0" } as const;

/** Every method this app sends or handles. */
export const METHOD = {
  /** app → host, request. Result carries `hostContext` + `hostCapabilities`. */
  initialize: "ui/initialize",
  /** app → host, notification. Unblocks the host's tool notifications. */
  initialized: "ui/notifications/initialized",
  /** host → app, notification: the tool arguments (the form schema). */
  toolInput: "ui/notifications/tool-input",
  /** host → app, notification: a streaming prefix of the same. */
  toolInputPartial: "ui/notifications/tool-input-partial",
  /** host → app, notification: the stub result (§3) — ignored. */
  toolResult: "ui/notifications/tool-result",
  /** host → app, notification: cancelled. Freeze, stop autosaving. */
  toolCancelled: "ui/notifications/tool-cancelled",
  /** host → app, notification: partial host context; merge it. */
  hostContextChanged: "ui/notifications/host-context-changed",
  /** host → app, REQUEST: respond when the final flush is done. */
  teardown: "ui/resource-teardown",
  /** app → host, request: plain MCP, proxied. How `save_draft` travels (§3). */
  toolsCall: "tools/call",
  /** app → host, request: overwrites, does not trigger a turn (§7.2). */
  updateModelContext: "ui/update-model-context",
  /** app → host, request: submit — triggers the next turn. */
  message: "ui/message",
  /** app → host, request: inline → fullscreen. */
  requestDisplayMode: "ui/request-display-mode",
  /** app → host, notification: inline auto-fit. */
  sizeChanged: "ui/notifications/size-changed",
} as const;

export type DisplayModeName = "inline" | "fullscreen" | "pip";

/** `hostContext.styles.variables` — standardized `--color-*` / `--font-*` keys (§7.4). */
export type StyleVariables = Record<string, string | undefined>;

export type HostContext = {
  toolInfo?: { id?: string | number; tool?: unknown };
  theme?: "light" | "dark";
  styles?: { variables?: StyleVariables; css?: { fonts?: string } };
  displayMode?: DisplayModeName;
  availableDisplayModes?: DisplayModeName[];
  containerDimensions?: {
    height?: number;
    width?: number;
    maxHeight?: number;
    maxWidth?: number;
  };
  locale?: string;
  timeZone?: string;
  userAgent?: string;
  platform?: "web" | "desktop" | "mobile";
  deviceCapabilities?: { touch?: boolean; hover?: boolean };
  safeAreaInsets?: { top: number; right: number; bottom: number; left: number };
};

export type InitializeResult = {
  protocolVersion?: string;
  hostInfo?: { name?: string; version?: string };
  hostCapabilities?: Record<string, unknown>;
  hostContext?: HostContext;
};

/** The app-visible autosave tool (§3 — the iframe cannot POST anywhere). */
export const SAVE_DRAFT_TOOL = "save_draft";

/**
 * The app-visible state pull. Forced by §7.2: the host delivers only tool INPUT
 * to the app, so a `load_form` render arrives knowing nothing but the formId and
 * has to fetch its own schema and answers.
 */
export const GET_FORM_STATE_TOOL = "get_form_state";

/** What a proxied `tools/call` resolves to — plain MCP `CallToolResult`. */
export type ToolCallResult = {
  content?: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};
