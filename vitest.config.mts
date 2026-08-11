import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      // The real "obsidian" package has no runtime implementation — it is
      // provided by the app at load time. Tests use a minimal stub instead.
      { find: /^obsidian$/, replacement: `${root}tests/stubs/obsidian.ts` },
      // Mirrors the tsconfig baseUrl so "src/..." imports resolve.
      { find: /^src\//, replacement: `${root}src/` },
    ],
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
