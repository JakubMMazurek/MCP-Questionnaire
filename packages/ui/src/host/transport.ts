/**
 * The transport seam.
 *
 * Everything above this file speaks JSON-RPC objects and nothing else, so the
 * dev harness (Stage D) can play host over the same code path the real host
 * uses — either through a real `postMessage` pair across an iframe boundary, or
 * through an in-process pair in a test.
 */

export type JsonRpcId = string | number;

export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
};

export type JsonRpcNotification = { jsonrpc: "2.0"; method: string; params?: unknown };

export type JsonRpcError = { code: number; message: string; data?: unknown };

export type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: JsonRpcError;
};

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export type Transport = {
  send: (message: JsonRpcMessage) => void;
  /** Registers a listener; returns the unsubscribe. */
  onMessage: (handler: (message: JsonRpcMessage) => void) => () => void;
  start: () => void;
  stop: () => void;
};

export function isJsonRpc(value: unknown): value is JsonRpcMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { jsonrpc?: unknown }).jsonrpc === "2.0"
  );
}

type Listener = (message: JsonRpcMessage) => void;

function fanout() {
  const listeners = new Set<Listener>();
  return {
    add(listener: Listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(message: JsonRpcMessage) {
      for (const listener of [...listeners]) listener(message);
    },
    clear() {
      listeners.clear();
    },
  };
}

export type WindowTransportOptions = {
  /** Where messages go. A function, because an iframe's window appears late. */
  target: () => Window | null | undefined;
  /** Where messages arrive. Defaults to the global window. */
  source?: Window;
  /**
   * Accepted sender. The spec documents `postMessage(msg, "*")` and no origin
   * handshake, so the default accepts any origin and filters on shape instead.
   */
  accept?: (event: MessageEvent) => boolean;
};

/** postMessage transport. Used by the app (target = parent) and by the harness. */
export function windowTransport(options: WindowTransportOptions): Transport {
  const source = options.source ?? window;
  const listeners = fanout();
  let attached: ((event: MessageEvent) => void) | null = null;

  return {
    send(message) {
      options.target()?.postMessage(message, "*");
    },
    onMessage: listeners.add,
    start() {
      if (attached) return;
      attached = (event: MessageEvent) => {
        if (options.accept && !options.accept(event)) return;
        if (isJsonRpc(event.data)) listeners.emit(event.data);
      };
      source.addEventListener("message", attached);
    },
    stop() {
      if (attached) source.removeEventListener("message", attached);
      attached = null;
      listeners.clear();
    },
  };
}

/** The app side of the real bridge: talk to whatever framed us. */
export function parentTransport(): Transport {
  return windowTransport({ target: () => window.parent });
}

/**
 * Two transports wired to each other, delivered on a microtask so ordering
 * matches the real thing (a reply never arrives inside `send`).
 */
export function memoryPair(): { app: Transport; host: Transport } {
  const toApp = fanout();
  const toHost = fanout();
  const make = (
    out: ReturnType<typeof fanout>,
    incoming: ReturnType<typeof fanout>,
  ): Transport => ({
    send(message) {
      const copy = JSON.parse(JSON.stringify(message)) as JsonRpcMessage;
      queueMicrotask(() => out.emit(copy));
    },
    onMessage: incoming.add,
    start() {},
    stop() {
      incoming.clear();
    },
  });
  return { app: make(toHost, toApp), host: make(toApp, toHost) };
}
