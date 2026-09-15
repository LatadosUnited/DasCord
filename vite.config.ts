import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// @ts-expect-error type error without @types/node package
import process from "node:process";
// Fonte única da versão do app (veja scripts/sync-version.mjs).
// Importado (e não lido com fs) para o Vite reiniciar sozinho quando a versão mudar.
import pkg from "./package.json";
const host = process.env.TAURI_DEV_HOST;
const appVersion: string = pkg.version;

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react()],

  // Disponível no código como __APP_VERSION__ (declarado em src/vite-env.d.ts)
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching rust directories
      ignored: ["**/src-tauri/**", "**/server/**", "**/target/**"],
    },
  },
}));
