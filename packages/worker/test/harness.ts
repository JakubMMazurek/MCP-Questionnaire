/**
 * A real MCP client talking to the real Worker.
 *
 * The transport's `fetch` is pointed at the Worker's own default export inside
 * workerd, so every test below exercises the whole path: HTTP, the base-path
 * routing, `createMcpHandler`'s Streamable HTTP transport, JSON-RPC framing,
 * `inputSchema` validation, the tool handler, the SQLite-backed Durable Object
 * and the ASSETS binding. Nothing is stubbed, which is the point — the parts of
 * this build most likely to be wrong are the platform seams, and a mock of a
 * seam proves nothing about the seam.
 */

import { SELF } from "cloudflare:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { DEV_PLACEHOLDER_BASE_PATH } from "../src/base-path.js";

/** Matches wrangler.jsonc's `vars.BASE_PATH`, which is localhost-only by design. */
export const MCP_URL = new URL(`http://localhost/${DEV_PLACEHOLDER_BASE_PATH}/mcp`);

export type ToolResult = {
  content?: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

export async function connect(): Promise<{
  client: Client;
  call: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
  close: () => Promise<void>;
}> {
  const transport = new StreamableHTTPClientTransport(MCP_URL, {
    /**
     * `SELF.fetch` does not synthesise a `Host` header, and the handler
     * validates it (that is `allowedHostnames`' localhost default doing its
     * job), so it is set explicitly here. This is a property of the test
     * harness, not of the Worker: a real HTTP client always sends one.
     */
    fetch: (async (input: Request | string | URL, init?: RequestInit) => {
      const request = new Request(input as never, init as never);
      const headers = new Headers(request.headers);
      headers.set("Host", MCP_URL.host);
      return SELF.fetch(
        new Request(request.url, {
          method: request.method,
          headers,
          body: request.method === "GET" || request.method === "HEAD" ? null : request.body,
        }) as never,
      );
    }) as never,
  });
  const client = new Client({ name: "gather-decisions-tests", version: "0.0.0" });
  await client.connect(transport);

  return {
    client,
    /**
     * `tools/call` without the SDK's result-schema narrowing, because these
     * tests assert on `isError` and on `structuredContent` shapes the SDK's
     * default schema would strip.
     */
    call: async (name, args) =>
      (await client.callTool({ name, arguments: args })) as unknown as ToolResult,
    close: async () => {
      await client.close();
    },
  };
}

/** The text of the first content item — what actually lands in model context. */
export function firstText(result: ToolResult): string {
  return result.content?.[0]?.text ?? "";
}
