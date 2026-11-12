import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// Shared with the backend so the proxy target can never drift from the port the
// API actually binds. Defaults to 3001 when PORT is unset.
import { getHost, getPort } from "../backend/runtime.js";

const apiTarget = `http://${getHost()}:${getPort()}`;
const proxy = {
  "/api": apiTarget,
  "/uploads": apiTarget,
};

export default defineConfig({
  root: "web",
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    proxy,
  },
  preview: {
    proxy,
  },
});
