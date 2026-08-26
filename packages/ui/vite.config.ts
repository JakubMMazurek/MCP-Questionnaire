import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

/**
 * The `ui://forms/renderer` bundle: ONE self-contained HTML file.
 *
 * The iframe runs under the host's default CSP — `default-src 'none';
 * script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline';
 * connect-src 'none'` (§3) — so a bundle that loads anything at runtime does
 * not degrade, it breaks silently. Everything is inlined here, and the build is
 * checked for external references (`pnpm --filter @gather/ui verify`).
 *
 * `pnpm --filter @gather/ui dev` also serves the host harness at /dev/, which
 * plays host over the same transport (dev/harness.tsx). The harness is not part
 * of the production input.
 */
export default defineConfig({
  plugins: [react(), tailwindcss(), viteSingleFile()],
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
