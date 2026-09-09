import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

/**
 * The `ui://forms/renderer` bundle: ONE self-contained HTML file.
 *
 * The iframe runs under the host's default CSP — `default-src 'none';
 * script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline';
 * connect-src 'none'` (§3) — so a bundle that loads anything at runtime does
 * not degrade, it breaks silently. Everything is inlined here, and the build is
 * checked for external references (`pnpm --filter @mcpq/ui verify`).
 *
 * `pnpm --filter @mcpq/ui dev` also serves the host harness at /dev/, which
 * plays host over the same transport (dev/harness.tsx). The harness is not part
 * of the production input.
 */
/**
 * `/dev/save-draft`, under `vite dev` only.
 *
 * The standalone page POSTs its drafts to an origin it expects to answer with
 * the Worker's `save_draft` verdict. This stands in for that while the preview
 * runs with no Worker, so the dev page exercises the real success path instead
 * of the give-up path. `apply: "serve"` keeps it out of every build.
 */
const devEndpoints: Plugin = {
  name: "mcpq-dev-endpoints",
  apply: "serve",
  configureServer(server) {
    server.middlewares.use("/dev/save-draft", (_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true, saved: 1, deleted: 0 }));
    });
  },
};

export default defineConfig({
  plugins: [react(), tailwindcss(), viteSingleFile(), devEndpoints],
  build: {
    outDir: "dist",
    target: "es2022",
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
    reportCompressedSize: true,
    rollupOptions: { input: "index.html" },
  },
  server: { open: "/dev/" },
});
