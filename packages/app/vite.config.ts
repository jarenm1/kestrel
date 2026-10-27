import { fileURLToPath } from "node:url"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// Local dev: `nix run` starts the Worker (control plane) and sets these per Linux user so several
// people can develop on one machine. Defaults match a single-user setup.
const CONTROL_PLANE = `http://127.0.0.1:${process.env.KESTREL_CONTROL_PORT ?? "8788"}`
const APP_PORT = Number(process.env.KESTREL_APP_PORT ?? "5173")

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    port: APP_PORT,
    strictPort: true,
    proxy: {
      "/api": { target: CONTROL_PLANE, ws: true },
      "/auth": { target: CONTROL_PLANE },
      "/box": { target: CONTROL_PLANE, ws: true },
    },
  },
})
