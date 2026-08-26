/**
 * The Worker entry (DESIGN.html §3).
 *
 * Two jobs and no third: serve MCP over Streamable HTTP under the unguessable
 * base path, and hold the form Durable Object class. There is no domain logic
 * here — the server computes nothing about the domain and holds no credentials.
 *
 * Routing, in order:
 *   /<BASE_PATH>/mcp   -> the MCP handler (POST for calls; GET/DELETE are 405,
 *                         which is correct for a stateless transport)
 *   everything else    -> 404, including `/`
 *
 * That last line is deliberate. `run_worker_first: true` in wrangler.jsonc means
 * the ASSETS binding does not serve anything publicly; the renderer bundle is
 * reachable only through `resources/read` on `ui://forms/renderer`, which is
 * itself only reachable under the base path. Nothing about the deployment is
 * discoverable by fetching `/`.
 */

import { createMcpHandler } from "agents/mcp/server";
import { BASE_PATH_DIAGNOSIS, resolveBasePath } from "./base-path.js";
import type { WorkerEnv } from "./env.js";
import { logConfigError } from "./log.js";
import { createServer } from "./mcp-server.js";

export { FormDO } from "./form-do.js";

/**
 * One handler per base path, memoised across requests in the same isolate.
 *
 * The handler must know its exact route (it 404s anything else), and the route
 * comes from an environment variable, so it cannot be built at module scope.
 * The MCP SERVER is still constructed per request by the factory — that is the
 * stateless model, and it is what makes `env` capture safe here.
 */
const handlers = new Map<string, ReturnType<typeof createMcpHandler>>();

function handlerFor(env: WorkerEnv, route: string) {
  const cached = handlers.get(route);
  if (cached) return cached;
  const handler = createMcpHandler(() => createServer(env), {
    route,
    /**
     * Anthropic custom connectors are dialled server-to-server from
     * Anthropic's cloud, so there is no browser Origin to police and no
     * cross-origin page that needs to reach this endpoint. The handler's
     * default is wildcard CORS plus Origin validation (it rejects malformed,
     * opaque and non-HTTP Origins with 403), which is the right shape: an
     * absent Origin — every non-browser MCP client — stays valid.
     *
     * `allowedHostnames` is deliberately unset: localhost and workers.dev get
     * matching defaults, and a custom domain relies on Cloudflare routing.
     * Setting it would be one more place to forget when the hostname changes.
     */
    onerror: (error) => {
      // Closed-vocabulary reporting only. An MCP error message can quote the
      // offending request, which for this server means answers and schemas
      // (§3 — never log payloads), so the name is logged and nothing else.
      logConfigError(`mcp_handler_error:${error.name}`);
    },
  });
  handlers.set(route, handler);
  return handler;
}

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const resolved = resolveBasePath(env, url);

    if (!resolved.ok) {
      // Fail CLOSED. A missing or unoverridden BASE_PATH must not degrade into
      // serving MCP at a guessable path; the operator gets a log line, the
      // caller gets the same 404 as any other path.
      logConfigError(BASE_PATH_DIAGNOSIS[resolved.reason]);
      return new Response("Not Found", { status: 404 });
    }

    if (url.pathname !== resolved.mcpRoute) {
      return new Response("Not Found", { status: 404 });
    }

    return handlerFor(env, resolved.mcpRoute)(request, env, ctx);
  },
} satisfies ExportedHandler<WorkerEnv>;
