import { defineConfig } from "vite";

export default defineConfig({
  build: {
    emptyOutDir: true,
    target: "node24",
    lib: {
      entry: "src/backend.ts",
      formats: ["es"],
      fileName: () => "backend.mjs",
    },
    rollupOptions: { external: [/^node:/u] },
  },
});
