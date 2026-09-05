import { defineConfig } from "vite";

export default defineConfig({
  build: {
    emptyOutDir: false,
    target: "es2022",
    lib: {
      entry: "src/frontend.ts",
      formats: ["es"],
      fileName: () => "frontend.mjs",
    },
  },
});
