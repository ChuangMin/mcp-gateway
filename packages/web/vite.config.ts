import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // In development the Gateway runs separately; forward its REST routes.
    proxy: {
      "/health": "http://127.0.0.1:3000",
      "/openapi.json": "http://127.0.0.1:3000",
    },
  },
});
