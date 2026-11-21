import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    include: [
      "test/workshops/**/*.test.ts",
      "test/auth/**/*.test.ts",
      "test/content/**/*.test.ts",
      "../web/test/workshops/**/*.test.ts",
    ],
  },
});
