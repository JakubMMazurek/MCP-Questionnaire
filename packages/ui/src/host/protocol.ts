/**
 * The MCP Apps wire vocabulary — extension `io.modelcontextprotocol/ui`,
 * revision 2026-01-26 (SEP-1865, Stable).
 *
 * This file used to hand-write the protocol. It no longer does: every constant
 * and every type below now comes from `@modelcontextprotocol/ext-apps`, the
 * official SDK, and this module is a thin naming layer over it so the rest of
 * the package (and the tests, and the harness) can keep reading `METHOD.toolsCall`
 * instead of a bare string.
 *
 * The reason for the swap is not tidiness. The hand-rolled `ui/initialize` sent
 * `clientInfo` where the schema requires `appInfo`, and `ui/message` sent a
 * single content block where the schema requires an array — our own fake host
 * accepted both (same author on both sides), and Claude's host, which validates
 * against these schemas, did not. A rejected connect is an invisible app.
 *
 * What the SDK does NOT give us is noted inline: two method strings have no
 * exported constant, so they are spelled out here and nowhere else.
 */

import {
  HOST_CONTEXT_CHANGED_METHOD,
  INITIALIZE_METHOD,
  INITIALIZED_METHOD,
  LATEST_PROTOCOL_VERSION,
  type McpUiDisplayMode,
  type McpUiHostContext,
  type McpUiHostCss,
  type McpUiInitializeResult,
  type McpUiStyles,
  MESSAGE_METHOD,
  REQUEST_DISPLAY_MODE_METHOD,
  RESOURCE_TEARDOWN_METHOD,
  SIZE_CHANGED_METHOD,
  TOOL_CANCELLED_METHOD,
  TOOL_INPUT_METHOD,
  TOOL_INPUT_PARTIAL_METHOD,
  TOOL_RESULT_METHOD,
} from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** `"2026-01-26"`, negotiated by the SDK — never by us. */
export const PROTOCOL_VERSION = LATEST_PROTOCOL_VERSION;

/** Sent as `ui/initialize` params `appInfo` (NOT `clientInfo` — that was the bug). */
export const APP_INFO = { name: "mcp-questionnaire-renderer", version: "0.1.0" } as const;

/**
 * Every method this app sends or handles, named. The SDK exports a constant for
 * all but two of them; those two are marked.
 */
export const METHOD = {
  /** app → host, request. Result carries `hostContext` + `hostCapabilities`. */
  initialize: INITIALIZE_METHOD,
  /** app → host, notification. Unblocks the host's tool notifications. */
  initialized: INITIALIZED_METHOD,
  /** host → app, notification: the tool arguments (the form schema). */
  toolInput: TOOL_INPUT_METHOD,
  /** host → app, notification: a streaming, brace-healed prefix of the same. */
  toolInputPartial: TOOL_INPUT_PARTIAL_METHOD,
  /** host → app, notification: the stub result (§3) — carries the formId. */
  toolResult: TOOL_RESULT_METHOD,
  /** host → app, notification: cancelled. Freeze, stop autosaving. */
  toolCancelled: TOOL_CANCELLED_METHOD,
  /** host → app, notification: partial host context; merge it. */
  hostContextChanged: HOST_CONTEXT_CHANGED_METHOD,
  /** host → app, REQUEST: respond when the final flush is done. */
  teardown: RESOURCE_TEARDOWN_METHOD,
  /**
   * app → host, request: plain MCP, proxied. How `save_draft` travels (§3).
   * No SDK constant — it is core MCP, not part of the UI extension.
   */
  toolsCall: "tools/call",
  /**
   * app → host, request: overwrites, does not trigger a turn (§7.2).
   * No SDK constant: `ext-apps` exports `MESSAGE_METHOD` and the rest, but not
   * this one. Spelled out here rather than at every call site.
   */
  updateModelContext: "ui/update-model-context",
  /** app → host, request: submit — triggers the next turn. */
  message: MESSAGE_METHOD,
  /** app → host, request: inline → fullscreen. */
  requestDisplayMode: REQUEST_DISPLAY_MODE_METHOD,
  /** app → host, notification: inline auto-fit. */
  sizeChanged: SIZE_CHANGED_METHOD,
} as const;

/** `"inline" | "fullscreen" | "pip"`. */
export type DisplayModeName = McpUiDisplayMode;

/**
 * `hostContext.styles.variables` — the closed `--color-*` / `--font-*` keys (§7.4).
 *
 * `Partial`, deliberately. The SDK types this as `Record<Key, string |
 * undefined>` — a TOTAL record — and says so in its own comment: the shape is
 * chosen "for compatibility with Zod schema generation", and is "functionally
 * equivalent for validation". It is not equivalent for TypeScript: a total
 * record makes every partial palette a type error, and a partial palette is the
 * normal case (§7.4 exists precisely because a host may send any subset).
 */
export type StyleVariables = Partial<McpUiStyles>;

export type HostStyles = { variables?: StyleVariables; css?: McpUiHostCss };

/**
 * The host environment as the extension defines it, with `styles` relaxed per
 * the note on {@link StyleVariables}. Written as a homomorphic mapped type so
 * every other field — and the extension's forward-compatibility index
 * signature — stays exactly the SDK's, and gains whatever the SDK gains.
 */
export type HostContext = {
  [K in keyof McpUiHostContext]: K extends "styles" ? HostStyles | undefined : McpUiHostContext[K];
};

export type InitializeResult = McpUiInitializeResult;

/** The app-visible autosave tool (§3 — the iframe cannot POST anywhere). */
export const SAVE_DRAFT_TOOL = "save_draft";

/**
 * The app-visible state pull. Forced by §7.2: the host delivers only tool INPUT
 * to the app, so a `load_form` render arrives knowing nothing but the formId and
 * has to fetch its own schema and answers.
 */
export const GET_FORM_STATE_TOOL = "get_form_state";

/** What a proxied `tools/call` resolves to — plain MCP `CallToolResult`. */
export type ToolCallResult = CallToolResult;
