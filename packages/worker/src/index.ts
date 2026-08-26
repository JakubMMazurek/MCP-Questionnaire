/**
 * The Worker entry (DESIGN.html §3).
 *
 * `OAuthProvider` owns `fetch`. It routes:
 *
 *   /.well-known/oauth-authorization-server   its own metadata (RFC 8414)
 *   /.well-known/oauth-protected-resource/*   its own metadata (RFC 9728)
 *   /token, /register                         its own endpoints (DCR included)
 *   /mcp                                      apiHandler, AFTER validating a
 *                                             bearer token; 401 with a
 *                                             `WWW-Authenticate` challenge
 *                                             otherwise
 *   everything else                           defaultHandler (the GitHub flow;
 *                                             404 for anything but /authorize
 *                                             and /callback, `/` included)
 *
 * The build-step-7 change this replaces: the MCP endpoint used to live under an
 * unguessable `BASE_PATH` segment with no auth at all, and the URL was the
 * capability. That worked only while the repo carrying the URL stayed private,
 * and it stopped working the moment the connector had to be installed from a
 * public plugin marketplace. The path is now plain `/mcp` and identity does the
 * work the secrecy used to do. The formId is still a capability internally —
 * that part of §3 is untouched.
 *
 * `run_worker_first: true` still keeps the renderer bundle off the public
 * routes: the ASSETS binding is read only by `resources/read`, which is behind
 * the bearer token now rather than behind a secret path.
 */

import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import type { WorkerEnv } from "./env.js";
import { githubHandler } from "./github-handler.js";
import { logConfigError } from "./log.js";
import { createServer } from "./mcp-server.js";

export { FormDO } from "./form-do.js";

/** The MCP route. Must match `apiRoute` below — the handler 404s anything else. */
export const MCP_ROUTE = "/mcp";

/**
 * One handler per isolate.
 *
 * It is built on first request rather than at module scope only because the
 * server factory closes over `env`, which module scope does not have. The MCP
 * SERVER is still constructed per request by the factory — that is the
 * stateless model, and it is what makes capturing `env` here safe.
 */
let mcpHandler: ReturnType<typeof createMcpHandler> | undefined;

function handlerFor(env: WorkerEnv) {
  mcpHandler ??= createMcpHandler(() => createServer(env), {
    route: MCP_ROUTE,
    /**
     * Custom connectors are dialled server-to-server from Anthropic's cloud,
     * so there is no browser Origin to police and no cross-origin page that
     * needs to reach this endpoint. The handler's default is wildcard CORS
     * plus Origin validation (malformed, opaque and non-HTTP Origins get 403),
     * which is the right shape: an absent Origin — every non-browser MCP
     * client — stays valid.
     *
     * `allowedHostnames` is deliberately unset: localhost and workers.dev get
     * matching defaults, and a custom domain relies on Cloudflare routing.
     */
    onerror: (error) => {
      // Closed-vocabulary reporting only. An MCP error message can quote the
      // offending request, which for this server means answers and schemas
      // (§3 — never log payloads), so the name is logged and nothing else.
      logConfigError(`mcp_handler_error:${error.name}`);
    },
  });
  return mcpHandler;
}

/**
 * The protected API handler.
 *
 * This wrapper is load-bearing, not ceremony. `createMcpHandler` returns a
 * callable `(request, env, ctx)` with a `.fetch(request, requestOptions)`
 * property whose SECOND argument is per-request options, not `env` — and
 * OAuthProvider invokes an `ExportedHandler`-shaped `apiHandler` as
 * `handler.fetch(request, env, ctx)`. Handing it the raw handler object would
 * therefore call the two-argument face with `env` in the options slot and drop
 * `ctx` entirely, which is precisely where the identity lives.
 *
 * Passing `ctx` through to the CALLABLE face is what carries the grant into the
 * tools: OAuthProvider decrypts the grant's props onto `ctx.props`, and the
 * agents wrapper lifts a non-empty `ctx.props` into the AsyncLocalStorage that
 * `getMcpAuthContext()` reads (agents 0.21.0, `handler-stateless`:
 * `authContext ?? (verified ? … : workerCtx?.props && … ? { props: workerCtx.props } : undefined)`).
 * No glue, no header parsing, no second source of truth.
 */
const apiHandler = {
  fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    return handlerFor(env)(request, env, ctx);
  },
} satisfies ExportedHandler<WorkerEnv>;

/**
 * `scopesSupported` is deliberately omitted: this server has exactly one
 * permission level (you are on the allowlist or you are not), so advertising a
 * scope vocabulary would invent a distinction the tools do not make. Requested
 * scopes are granted through unchanged.
 *
 * `resourceMetadata` is omitted too. Without it the provider derives the
 * protected-resource document from the request URL, which is right for a Worker
 * that answers on `workers.dev`, on localhost under `wrangler dev`, and inside
 * workerd under test — pinning `resource` to one absolute URL would break two
 * of those three for no gain.
 *
 * Dynamic client registration is ON (`clientRegistrationEndpoint`), and it has
 * to be: claude.ai custom connectors and Claude Code both register themselves.
 */
export default new OAuthProvider<WorkerEnv>({
  apiRoute: MCP_ROUTE,
  apiHandler,
  defaultHandler: githubHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
});
