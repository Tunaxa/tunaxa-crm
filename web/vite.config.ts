import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "web",
  plugins: [react()],

  server: {
    host: "127.0.0.1",
    proxy: {
      "/api": "http://127.0.0.1:3001",
      "/uploads": "http://127.0.0.1:3001",
    },
  },

  preview: {
    proxy: {
      "/api": "http://127.0.0.1:3001",
      "/uploads": "http://127.0.0.1:3001",
    },
  },

  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("@xyflow")) {
            return "react-flow";
          }
        },
      },
    },
  },
});
