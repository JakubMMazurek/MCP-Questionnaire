import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    // Engine and bridge tests are pure; component tests opt into jsdom with a
    // `@vitest-environment jsdom` docblock so the DOM cost is paid only there.
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
