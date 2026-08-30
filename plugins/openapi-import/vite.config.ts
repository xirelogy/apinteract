import { defineConfig } from "vite";

export default defineConfig({
  build: {
    emptyOutDir: true,
    target: "node22",
    lib: {
      entry: "src/index.ts",
      formats: ["es"],
      fileName: () => "index.mjs",
    },
    rollupOptions: { external: [/^node:/u] },
  },
});
