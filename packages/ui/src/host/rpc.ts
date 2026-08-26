/**
 * A minimal JSON-RPC 2.0 peer over a `Transport`. Both directions: the app
 * sends requests (`ui/initialize`, `tools/call`, `ui/message`) and answers them
 * (`ui/resource-teardown` is a request, §7.2).
 *
 * Deliberately small — the alternative is pulling in an SDK that assumes a
 * network transport, and `connect-src 'none'` means nothing may fetch (§8).
 */

import type { JsonRpcId, JsonRpcMessage, Transport } from "./transport.js";

export type RpcHandlers = {
  /** Return value (or resolved value) becomes the JSON-RPC result. */
  onRequest?: (method: string, params: unknown) => unknown | Promise<unknown>;
  onNotification?: (method: string, params: unknown) => void;
};

export class RpcError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.data = data;
  }
}

const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;

type Pending = {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
};

export class RpcPeer {
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, Pending>();
  private readonly detach: () => void;
  private readonly transport: Transport;
  private readonly handlers: RpcHandlers;
  private closed = false;

  constructor(transport: Transport, handlers: RpcHandlers = {}) {
    this.transport = transport;
    this.handlers = handlers;
    this.detach = transport.onMessage((message) => {
      void this.receive(message);
    });
    transport.start();
  }

  /** Sends a request. `timeoutMs` guards against a host that never answers. */
  request<T = unknown>(method: string, params?: unknown, timeoutMs = 15_000): Promise<T> {
    if (this.closed) return Promise.reject(new RpcError(INTERNAL_ERROR, "bridge closed"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const pending: Pending = { resolve: resolve as (value: unknown) => void, reject };
      if (timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new RpcError(INTERNAL_ERROR, `${method} timed out`));
        }, timeoutMs);
      }
      this.pending.set(id, pending);
      this.transport.send({
        jsonrpc: "2.0",
        id,
        method,
        ...(params === undefined ? {} : { params }),
      });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    this.transport.send({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  }

  close(): void {
    this.closed = true;
    for (const [, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(new RpcError(INTERNAL_ERROR, "bridge closed"));
    }
    this.pending.clear();
    this.detach();
  }

  private async receive(message: JsonRpcMessage): Promise<void> {
    if ("id" in message && !("method" in message)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (pending.timer) clearTimeout(pending.timer);
      if (message.error)
        pending.reject(new RpcError(message.error.code, message.error.message, message.error.data));
      else pending.resolve(message.result);
      return;
    }

    if (!("method" in message)) return;

    if (!("id" in message)) {
      this.handlers.onNotification?.(message.method, message.params);
      return;
    }

    const id = message.id;
    if (!this.handlers.onRequest) {
      this.transport.send({
        jsonrpc: "2.0",
        id,
        error: { code: METHOD_NOT_FOUND, message: `unhandled method ${message.method}` },
      });
      return;
    }
    try {
      const result = await this.handlers.onRequest(message.method, message.params);
      this.transport.send({ jsonrpc: "2.0", id, result: result ?? {} });
    } catch (cause) {
      const error =
        cause instanceof RpcError
          ? { code: cause.code, message: cause.message, data: cause.data }
          : { code: INTERNAL_ERROR, message: cause instanceof Error ? cause.message : "error" };
      this.transport.send({ jsonrpc: "2.0", id, error });
    }
  }
}
