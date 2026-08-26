/**
 * The unguessable base path (§3, §10) and the fail-closed rule around it.
 *
 * These are the tests that would catch the worst deploy mistake this project
 * can make: shipping the MCP endpoint at a path someone can guess.
 */

import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { DEV_PLACEHOLDER_BASE_PATH, resolveBasePath } from "../src/base-path.js";

const url = (href: string) => new URL(href);

describe("base path resolution", () => {
  it("serves MCP only under /<BASE_PATH>/mcp", () => {
    const resolved = resolveBasePath({ BASE_PATH: "a1b2c3d4e5f60718" } as never, url("https://x/"));
    expect(resolved).toEqual({
      ok: true,
      basePath: "a1b2c3d4e5f60718",
      mcpRoute: "/a1b2c3d4e5f60718/mcp",
    });
  });

  it("fails closed when BASE_PATH is unset", () => {
    expect(resolveBasePath({} as never, url("https://x/"))).toEqual({ ok: false, reason: "unset" });
  });

  it("refuses anything that is not a single path segment", () => {
    for (const bad of ["a/b", "..", ".", "x", "has space", "a?b", "a#b"]) {
      const resolved = resolveBasePath({ BASE_PATH: bad } as never, url("https://x/"));
      expect(resolved.ok, bad).toBe(false);
    }
  });

  it("refuses the wrangler.jsonc placeholder anywhere but localhost", () => {
    const env = { BASE_PATH: DEV_PLACEHOLDER_BASE_PATH } as never;
    expect(resolveBasePath(env, url("http://localhost:8787/")).ok).toBe(true);
    expect(resolveBasePath(env, url("http://127.0.0.1/")).ok).toBe(true);
    expect(resolveBasePath(env, url("https://gather-decisions.workers.dev/"))).toEqual({
      ok: false,
      reason: "placeholder-off-localhost",
    });
  });
});

describe("routing", () => {
  it("404s the root — the renderer bundle is not a public page", async () => {
    const response = await SELF.fetch("http://localhost/");
    expect(response.status).toBe(404);
  });

  it("404s a near miss on the MCP path", async () => {
    for (const path of [
      "/mcp",
      `/${DEV_PLACEHOLDER_BASE_PATH}`,
      `/${DEV_PLACEHOLDER_BASE_PATH}/`,
    ]) {
      const response = await SELF.fetch(`http://localhost${path}`);
      expect(response.status, path).toBe(404);
    }
  });

  it("404s index.html — assets are reachable only through resources/read", async () => {
    const response = await SELF.fetch("http://localhost/index.html");
    expect(response.status).toBe(404);
  });

  it("answers on the MCP path", async () => {
    const response = await SELF.fetch(`http://localhost/${DEV_PLACEHOLDER_BASE_PATH}/mcp`);
    // 405: GET and DELETE are session operations, and a stateless transport has
    // no sessions. What matters is that it is the handler answering, not the 404.
    expect(response.status).not.toBe(404);
  });
});
