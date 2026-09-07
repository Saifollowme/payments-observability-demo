import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Must match the GitHub repo name exactly — GitHub Pages serves this project
  // from https://<username>.github.io/payments-observability-demo/, so every
  // asset path needs this prefix or the deployed page will load a blank screen.
  base: "/payments-observability-demo/",
});
