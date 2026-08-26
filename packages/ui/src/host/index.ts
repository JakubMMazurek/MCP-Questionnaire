/**
 * The host bridge — MCP Apps postMessage JSON-RPC (§7), spoken through
 * `@modelcontextprotocol/ext-apps`.
 *
 * `fake-host.ts` is deliberately NOT re-exported here. It pulls in the SDK's
 * host-side `AppBridge`, which has no business in a bundle that only ever plays
 * the app; the tests and the dev harness import it by path.
 */

export {
  type Bridge,
  type BridgeEvent,
  type BridgeOptions,
  createBridge,
  type DraftOutcome,
  draftOutcome,
  extractForm,
  loadFormId,
  MODEL_CONTEXT_DEBOUNCE_MS,
  resultFormId,
  SAVE_DRAFT_DEBOUNCE_MS,
} from "./bridge.js";
export { applyHostContext, mergeHostContext } from "./dom.js";
export {
  APP_INFO,
  type DisplayModeName,
  GET_FORM_STATE_TOOL,
  type HostContext,
  type InitializeResult,
  METHOD,
  PROTOCOL_VERSION,
  SAVE_DRAFT_TOOL,
  type StyleVariables,
  type ToolCallResult,
} from "./protocol.js";
