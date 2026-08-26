/**
 * The unguessable base path (§3, §10 "Endpoint exposure — unguessable path only").
 *
 * No auth exists anywhere in this server: form state at rest is reachable only
 * via its unguessable formId, and the MCP endpoint itself is reachable only
 * under an unguessable path segment. Custom connectors are dialled from
 * Anthropic's cloud, so the endpoint is public regardless — an IP allowlist was
 * considered and rejected (§10), which leaves the path as the whole story.
 *
 * That makes a forgotten override a security bug, not a config nit. So the
 * placeholder shipped in wrangler.jsonc is refused anywhere but localhost: a
 * deploy that never set BASE_PATH serves nothing at all rather than serving MCP
 * at a path an attacker can guess in one try.
 */
import type { WorkerEnv } from "./env.js";

/** The value in wrangler.jsonc's `vars`. Local development only. */
export const DEV_PLACEHOLDER_BASE_PATH = "local-dev";

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

/** A path segment: one URL segment, no slashes, no dots, nothing to traverse with. */
const SEGMENT = /^[A-Za-z0-9._~-]{4,128}$/;

export type BasePathResolution =
  | { ok: true; basePath: string; mcpRoute: string }
  | { ok: false; reason: "unset" | "malformed" | "placeholder-off-localhost" };

function isLocal(hostname: string): boolean {
  return LOCAL_HOSTNAMES.has(hostname) || hostname.endsWith(".localhost");
}

export function resolveBasePath(env: WorkerEnv, url: URL): BasePathResolution {
  const raw = env.BASE_PATH?.trim();
  if (!raw) return { ok: false, reason: "unset" };
  if (!SEGMENT.test(raw) || raw === "." || raw === "..") {
    return { ok: false, reason: "malformed" };
  }
  if (raw === DEV_PLACEHOLDER_BASE_PATH && !isLocal(url.hostname)) {
    return { ok: false, reason: "placeholder-off-localhost" };
  }
  return { ok: true, basePath: raw, mcpRoute: `/${raw}/mcp` };
}

/** What an operator needs to read in the logs. Carries no request data. */
export const BASE_PATH_DIAGNOSIS: Record<
  Exclude<BasePathResolution, { ok: true }>["reason"],
  string
> = {
  unset:
    "BASE_PATH is unset — the MCP endpoint is disabled. Set it to a crypto-random path segment (openssl rand -hex 16).",
  malformed:
    "BASE_PATH is not a single URL path segment ([A-Za-z0-9._~-]{4,128}) — the MCP endpoint is disabled.",
  "placeholder-off-localhost": `BASE_PATH is still the "${DEV_PLACEHOLDER_BASE_PATH}" placeholder from wrangler.jsonc, which is refused off localhost — the MCP endpoint is disabled. Set a crypto-random BASE_PATH as an encrypted environment variable.`,
};
