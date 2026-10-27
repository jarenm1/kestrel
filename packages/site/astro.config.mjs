import tailwindcss from "@tailwindcss/vite"
import { defineConfig } from "astro/config"

// Static marketing site for kestrel-agent.com. The product app lives on app.kestrel-agent.com.
export default defineConfig({
  site: "https://kestrel-agent.com",
  output: "static",
  vite: { plugins: [tailwindcss()] },
})
