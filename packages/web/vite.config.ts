import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// Local dev: the Worker (control plane) must run on port 8788, not wrangler's default 8787,
// because the agent box serves its REST API on 8787. Start it with:
//   npx wrangler dev --port 8788   (from packages/web)
const CONTROL_PLANE = "http://127.0.0.1:8788"

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": { target: CONTROL_PLANE, ws: true },
      "/auth": { target: CONTROL_PLANE },
      "/box": { target: CONTROL_PLANE, ws: true },
    },
  },
})
