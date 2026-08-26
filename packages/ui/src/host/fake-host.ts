/**
 * A host, played by the SDK's own host-side class.
 *
 * `AppBridge` is the counterpart to `App`: same protocol implementation, same
 * generated schemas, opposite end of the wire. Using it here is what makes the
 * bridge tests and the dev harness worth anything — a fake host we wrote
 * ourselves would accept whatever we sent, which is precisely how a
 * `clientInfo`-where-`appInfo`-belongs bug survives a green suite and dies in
 * claude.ai.
 *
 * What is still ours is the tape: every JSON-RPC message the app sends is
 * recorded before `AppBridge` sees it, so tests can assert on the wire and the
 * harness can print it. `Protocol.connect` chains the transport's existing
 * `onmessage` ahead of its own, so the tap costs one assignment.
 */

import type { McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  CallToolRequest,
  CallToolResult,
  JSONRPCMessage,
  RequestId,
} from "@modelcontextprotocol/sdk/types.js";
import type { DisplayModeName, HostContext } from "./protocol.js";

export type Seen = { method: string; params: unknown; id?: RequestId };

export type FakeHostOptions = {
  transport: Transport;
  /** A function when the context is decided late (the harness's theme toggle). */
  hostContext?: HostContext | (() => HostContext);
  /** Return an `Error` to reject a `tools/call` — e.g. `save_draft` not deployed. */
  onToolsCall?: (params: CallToolRequest["params"]) => unknown | Error;
  /** Decide what a display-mode request is granted. Defaults to granting it. */
  onDisplayMode?: (mode: DisplayModeName) => DisplayModeName;
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
  /** The stub result (§3) — the channel the formId travels on. */
  sendToolResult: (result: unknown) => void;
  sendCancelled: (reason?: string) => void;
  sendContextChange: (patch: HostContext) => void;
  /** Reject the NEXT request of `method` — e.g. a context push that fails. */
  failNext: (method: string) => void;
  /** Sends the teardown REQUEST and resolves when the app answers. */
  teardown: () => Promise<Seen[]>;
  stop: () => void;
};

const HOST_INFO = { name: "fake-host", version: "0.0.0" } as const;

/**
 * What this host claims to support. `serverTools` is the one that matters:
 * without it a real host has no reason to proxy `save_draft` at all.
 */
const HOST_CAPABILITIES = {
  serverTools: {},
  updateModelContext: { text: {}, structuredContent: {} },
  message: { text: {} },
  logging: {},
} as const;

export function createFakeHost(options: FakeHostOptions): FakeHost {
  const { transport } = options;
  const seen: Seen[] = [];

  const hostContext =
    (typeof options.hostContext === "function" ? options.hostContext() : options.hostContext) ??
    ({ theme: "light", displayMode: "inline" } as HostContext);

  // The tap. Set BEFORE connect: `Protocol.connect` keeps whatever handler it
  // finds and calls it first, so nothing is intercepted or swallowed.
  transport.onmessage = (message: JSONRPCMessage) => {
    if (!("method" in message)) return;
    const entry: Seen = { method: message.method, params: message.params };
    if ("id" in message) entry.id = message.id;
    seen.push(entry);
    options.onSeen?.(entry);
  };

  // `null` client: nothing to forward to, so every app→host request is answered
  // by a handler below rather than proxied to a real MCP server.
  // The cast is the `styles.variables` relaxation documented on `HostContext`:
  // a partial palette is legal on the wire, and only the SDK's TOTAL `Record`
  // type says otherwise.
  const bridge = new AppBridge(null, HOST_INFO, HOST_CAPABILITIES, {
    hostContext: hostContext as McpUiHostContext,
  });

  bridge.oncalltool = async (params): Promise<CallToolResult> => {
    const outcome = options.onToolsCall?.(params);
    if (outcome instanceof Error) throw outcome;
    return (outcome ?? { content: [{ type: "text", text: "saved" }] }) as CallToolResult;
  };

  const failing = new Set<string>();
  const failIfArmed = (method: string) => {
    if (!failing.delete(method)) return;
    throw new Error(`fake host: ${method} armed to fail`);
  };

  bridge.onupdatemodelcontext = async () => {
    failIfArmed("ui/update-model-context");
    return {};
  };
  bridge.onmessage = async () => ({});
  bridge.onrequestdisplaymode = async ({ mode }) => ({
    mode: options.onDisplayMode?.(mode) ?? mode,
  });

  // Fire-and-forget: `connect` is synchronous up to `transport.start()`, so the
  // host is listening by the time this returns.
  void bridge.connect(transport);

  return {
    seen,
    of: (method) => seen.filter((entry) => entry.method === method),
    last: (method) => [...seen].reverse().find((entry) => entry.method === method),
    sendToolInput: (args) => {
      void bridge.sendToolInput({ arguments: args as Record<string, unknown> });
    },
    sendPartial: (args) => {
      void bridge.sendToolInputPartial({ arguments: args as Record<string, unknown> });
    },
    sendToolResult: (result) => {
      void bridge.sendToolResult(result as CallToolResult);
    },
    sendCancelled: (reason = "user cancelled") => {
      void bridge.sendToolCancelled({ reason });
    },
    // The RAW partial send, not `setHostContext`: the harness and the tests
    // both want to say exactly which fields changed, and `setHostContext`
    // diffs against its own copy instead.
    sendContextChange: (patch) => {
      void bridge.sendHostContextChange(patch as McpUiHostContext);
    },
    failNext: (method) => {
      failing.add(method);
    },
    async teardown() {
      // `ui/resource-teardown` params are `{}` — the extension defines no
      // reason field, and the app has nothing to do with one anyway.
      await bridge.teardownResource({});
      return [...seen];
    },
    stop: () => {
      void bridge.close();
    },
  };
}
