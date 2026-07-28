import { fileURLToPath, URL } from "node:url";

import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

const browserTestBackendPort =
  process.env.APINTERACT_BROWSER_TEST_BACKEND_PORT ?? "8080";
const backendOrigin = `http://127.0.0.1:${browserTestBackendPort}`;

export default defineConfig({
  base: "/web-ui/",
  plugins: [vue()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@brand/logo.png": fileURLToPath(
        new URL("../../logo.png", import.meta.url),
      ),
    },
  },
  server: {
    port: 5173,
    fs: {
      allow: ["../.."],
    },
    proxy: {
      "/auth": backendOrigin,
      "/api": backendOrigin,
      "/health": backendOrigin,
      "/ws": {
        target: backendOrigin.replace("http:", "ws:"),
        ws: true,
      },
    },
  },
});
