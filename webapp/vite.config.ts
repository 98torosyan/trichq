import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: { target: "es2020", sourcemap: false, chunkSizeWarningLimit: 400 },
  server: {
    // `npm run dev` here + `npx wrangler dev` in ../worker (DEV_AUTH_BYPASS=1) for local work.
    proxy: { "/api": "http://127.0.0.1:8787" },
  },
});
