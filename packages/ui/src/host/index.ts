/**
 * The host bridge — MCP Apps postMessage JSON-RPC (§7).
 */

export {
  type Bridge,
  type BridgeEvent,
  type BridgeOptions,
  createBridge,
  extractForm,
  MODEL_CONTEXT_DEBOUNCE_MS,
  SAVE_DRAFT_DEBOUNCE_MS,
} from "./bridge.js";
export { applyHostContext, mergeHostContext } from "./dom.js";
export { createFakeHost, type FakeHost, type Seen } from "./fake-host.js";
export {
  APP_INFO,
  type DisplayModeName,
  type HostContext,
  type InitializeResult,
  METHOD,
  PROTOCOL_VERSION,
  SAVE_DRAFT_TOOL,
  type StyleVariables,
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
