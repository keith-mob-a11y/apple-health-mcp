import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  test: { globals: true, environment: "node", testTimeout: 60_000, hookTimeout: 60_000 },
  resolve: { alias: { "@": resolve(__dirname, ".") } },
});
