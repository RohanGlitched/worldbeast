import { defineConfig } from "vitest/config";
import path from "node:path";
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      // lets tests drive base44/actors/world/entry.ts in-process
      "base44:runtime/actors": path.resolve(__dirname, "src/net/__mocks__/actor-runtime.ts"),
    },
  },
  test: { include: ["src/**/*.test.ts", "base44/**/*.test.ts"] },
});
