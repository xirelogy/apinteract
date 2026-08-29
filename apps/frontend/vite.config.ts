import { fileURLToPath, URL } from "node:url";

import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

const browserTestBackendPort =
  process.env.APINTERACT_BROWSER_TEST_BACKEND_PORT ?? "8080";
const backendOrigin = `http://127.0.0.1:${browserTestBackendPort}`;
const backendProxy = {
  "/auth": backendOrigin,
  "/api": backendOrigin,
  "/health": backendOrigin,
  "/ws": {
    target: backendOrigin.replace("http:", "ws:"),
    ws: true,
  },
};

export const pwaOptions = {
  injectRegister: null,
  registerType: "prompt",
  manifest: {
    id: "/web-ui/",
    name: "APInteract",
    short_name: "APInteract",
    description: "A free and open-source API client for developers",
    start_url: "/web-ui/",
    scope: "/web-ui/",
    display: "standalone",
    background_color: "#1e2729",
    theme_color: "#1e2729",
    icons: [
      {
        src: "/web-ui/icons/icon-192.png",
        sizes: "192x192",
        type: "image/png",
      },
      {
        src: "/web-ui/icons/icon-512.png",
        sizes: "512x512",
        type: "image/png",
      },
      {
        src: "/web-ui/icons/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  },
  workbox: {
    cleanupOutdatedCaches: true,
    clientsClaim: false,
    skipWaiting: false,
    globPatterns: ["**/*.{js,css,html,ico,png,svg,json}"],
    navigateFallback: "/web-ui/index.html",
    navigateFallbackAllowlist: [/^\/web-ui\/(?:index\.html)?$/u],
    navigateFallbackDenylist: [/^\/(?:auth|api|ws)(?:\/|$)/u],
    runtimeCaching: [],
  },
} satisfies Parameters<typeof VitePWA>[0];

export default defineConfig({
  base: "/web-ui/",
  plugins: [vue(), VitePWA(pwaOptions)],
  build: {
    rollupOptions: {
      output: {
        /** Keeps editor and documentation dependencies out of the app shell. */
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("/@codemirror/view/")) return "codemirror-view";
          if (id.includes("/@codemirror/state/")) return "codemirror-state";
          if (id.includes("/@codemirror/language/")) {
            return "codemirror-language";
          }
          if (id.includes("/@codemirror/commands/")) {
            return "codemirror-commands";
          }
          if (id.includes("/@codemirror/")) return "codemirror-support";
          if (id.includes("/@lezer/")) return "lezer";
          if (
            id.includes("/dompurify/") ||
            id.includes("/markdown-it/") ||
            id.includes("/entities/") ||
            id.includes("/linkify-it/")
          ) {
            return "documentation-support";
          }
          return "vendor";
        },
      },
    },
  },
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
    proxy: backendProxy,
  },
  preview: {
    port: 5173,
    proxy: backendProxy,
  },
});
