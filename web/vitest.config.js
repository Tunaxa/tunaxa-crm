
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    testTimeout: 15000,
    fileParallelism: false,
    environment: "jsdom",
  },
});
