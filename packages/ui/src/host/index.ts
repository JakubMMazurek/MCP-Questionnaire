/**
 * The host bridge — MCP Apps postMessage JSON-RPC (§7).
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
export { createFakeHost, type FakeHost, type Seen } from "./fake-host.js";
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
export { RpcError, type RpcHandlers, RpcPeer } from "./rpc.js";
export {
  isJsonRpc,
  type JsonRpcMessage,
  memoryPair,
  parentTransport,
  type Transport,
  windowTransport,
} from "./transport.js";
