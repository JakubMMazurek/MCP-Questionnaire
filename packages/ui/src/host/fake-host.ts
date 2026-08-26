/**
 * A host, faked over the same transport the real one uses. Shared by the bridge
 * tests and (in a richer form) the dev harness, which is the point of the
 * transport seam: the app never knows the difference.
 */

import { type HostContext, type InitializeResult, METHOD, PROTOCOL_VERSION } from "./protocol.js";
import type { JsonRpcId, JsonRpcMessage, JsonRpcRequest, Transport } from "./transport.js";

export type Seen = { method: string; params: unknown; id?: JsonRpcId };

export type FakeHostOptions = {
  transport: Transport;
  /** A function when the context changes over time (the harness's theme toggle). */
  hostContext?: HostContext | (() => HostContext);
  /** Return an error to reject a `tools/call` — e.g. `save_draft` not deployed. */
  onToolsCall?: (params: unknown) => unknown | Error;
  onRequest?: (message: JsonRpcRequest) => unknown | Error | undefined;
  /** Every inbound message, as it arrives — the harness's log panel. */
  onSeen?: (entry: Seen) => void;
};

export type FakeHost = {
  /** Every request/notification the app sent, in order. */
  seen: Seen[];
  of: (method: string) => Seen[];
  last: (method: string) => Seen | undefined;
  sendToolInput: (args: unknown) => void;
  sendPartial: (args: unknown) => void;
  sendCancelled: (reason?: string) => void;
  sendContextChange: (patch: HostContext) => void;
  /** Sends the teardown REQUEST and resolves when the app answers. */
  teardown: (reason?: string) => Promise<Seen[]>;
  stop: () => void;
};

export function createFakeHost(options: FakeHostOptions): FakeHost {
  const { transport } = options;
  const seen: Seen[] = [];
  let nextId = 1000;
  const pending = new Map<JsonRpcId, (value: Seen[]) => void>();

  const reply = (id: JsonRpcId, result: unknown): void => {
    transport.send({ jsonrpc: "2.0", id, result });
  };
  const fail = (id: JsonRpcId, message: string): void => {
    transport.send({ jsonrpc: "2.0", id, error: { code: -32000, message } });
  };

  transport.onMessage((message: JsonRpcMessage) => {
    if (!("method" in message)) {
      // A response to one of our requests (only teardown, here).
      const resolve = pending.get(message.id);
      if (resolve) {
        pending.delete(message.id);
        resolve([...seen]);
      }
      return;
    }
    const entry: Seen = { method: message.method, params: message.params };
    if ("id" in message) entry.id = message.id;
    seen.push(entry);
    options.onSeen?.(entry);

    if (!("id" in message)) return;
    const request = message as JsonRpcRequest;

    const custom = options.onRequest?.(request);
    if (custom instanceof Error) return fail(request.id, custom.message);
    if (custom !== undefined) return reply(request.id, custom);

    switch (request.method) {
      case METHOD.initialize: {
        const context =
          typeof options.hostContext === "function" ? options.hostContext() : options.hostContext;
        const result: InitializeResult = {
          protocolVersion: PROTOCOL_VERSION,
          hostInfo: { name: "fake-host", version: "0.0.0" },
          hostCapabilities: {},
          hostContext: context ?? { theme: "light", displayMode: "inline" },
        };
        return reply(request.id, result);
      }
      case METHOD.toolsCall: {
        const outcome = options.onToolsCall?.(request.params);
        if (outcome instanceof Error) return fail(request.id, outcome.message);
        return reply(request.id, outcome ?? { content: [{ type: "text", text: "saved" }] });
      }
      case METHOD.requestDisplayMode: {
        const mode = (request.params as { mode?: string } | undefined)?.mode ?? "inline";
        return reply(request.id, { mode });
      }
      default:
        return reply(request.id, {});
    }
  });
  transport.start();

  const notify = (method: string, params: unknown): void => {
    transport.send({ jsonrpc: "2.0", method, params });
  };

  return {
    seen,
    of: (method) => seen.filter((entry) => entry.method === method),
    last: (method) => [...seen].reverse().find((entry) => entry.method === method),
    sendToolInput: (args) => notify(METHOD.toolInput, { arguments: args }),
    sendPartial: (args) => notify(METHOD.toolInputPartial, { arguments: args }),
    sendCancelled: (reason = "user cancelled") => notify(METHOD.toolCancelled, { reason }),
    sendContextChange: (patch) => notify(METHOD.hostContextChanged, patch),
    teardown(reason = "navigated away") {
      const id = nextId++;
      return new Promise<Seen[]>((resolve) => {
        pending.set(id, resolve);
        transport.send({ jsonrpc: "2.0", id, method: METHOD.teardown, params: { reason } });
      });
    },
    stop: () => transport.stop(),
  };
}
