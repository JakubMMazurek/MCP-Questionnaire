import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

/**
 * Tests run inside workerd, against the real wrangler.jsonc — the same bindings,
 * the same compatibility date, the real SQLite-backed Durable Object and the
 * real ASSETS binding. Nothing here is a mock of the platform.
 *
 * `@cloudflare/vitest-plugin` (not the older `@cloudflare/vitest-pool-workers`,
 * and `cloudflareTest()` not `defineWorkersConfig`) is what the current
 * Workers-testing docs prescribe; the helpers still come from `cloudflare:test`.
 */
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
});
