import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  root: "src",
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        reader: resolve(import.meta.dirname, "src/reader.html"),
        settings: resolve(import.meta.dirname, "src/settings.html"),
        overlay: resolve(import.meta.dirname, "src/overlay.html"),
      },
    },
  },
});
