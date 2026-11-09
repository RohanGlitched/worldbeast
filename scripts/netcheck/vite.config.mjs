import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
export default defineConfig({
  root: here,
  logLevel: "warn",
  resolve: {
    alias: [
      { find: "@/api/base44Client", replacement: join(here, "client-stub.ts") },
      { find: /^@\//, replacement: join(here, "../../src") + "/" },
    ],
  },
  define: { "process.env.NODE_ENV": '"production"' },
  build: {
    outDir: join(here, "dist"),
    emptyOutDir: true,
    minify: false,
    lib: { entry: join(here, "entry.ts"), name: "WBBundle", formats: ["iife"], fileName: () => "netcheck.js" },
  },
});
