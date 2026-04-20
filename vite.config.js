import { defineConfig } from "vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";

export default defineConfig({
  plugins: [
    // Polyfills Buffer, process, global etc. for TronWeb in browser (WebKit/Safari)
    nodePolyfills({
      globals: {
        Buffer:  true,
        global:  true,
        process: true,
      },
    }),
  ],
  server: {
    port: 3000,
    host: true,
  },
  build: {
    target: "es2020",
    outDir: "dist",
  },
});
