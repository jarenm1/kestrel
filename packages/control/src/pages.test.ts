import { describe, expect, test } from "bun:test"
import { MOBILE_PAGE, serveAppPage, type Assets } from "./pages"

const PHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1"
const ANDROID_PHONE = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36"
const ANDROID_TABLET = "Mozilla/5.0 (Linux; Android 15; SM-X910) AppleWebKit/537.36 Chrome/140.0 Safari/537.36"
const DESKTOP = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15"

const MOBILE_PATHS = ["/", "/c/3a591628-9dad-4ceb-afd8-58f669cc0e78", "/automations", "/archived", "/settings", "/settings/connections"]

/** An asset server that records the URL it was asked for and answers with its own Vary header. */
function stubAssets() {
  const fetched: string[] = []
  const assets: Assets = {
    fetch: async (request) => {
      fetched.push(new URL(request.url).pathname)
      return new Response("page", { headers: { "content-type": "text/html", vary: "Accept-Encoding" } })
    },
  }
  return { assets, fetched }
}

async function serve(path: string, init: { ua?: string; accept?: string; method?: string; host?: string } = {}) {
  const url = new URL(path, `https://${init.host ?? "app.kestrel-agent.com"}`)
  const headers: Record<string, string> = { accept: init.accept ?? "text/html,application/xhtml+xml" }
  if (init.ua) headers["user-agent"] = init.ua
  const request = new Request(url, { method: init.method ?? "GET", headers })
  const { assets, fetched } = stubAssets()
  const response = await serveAppPage(request, assets, url)
  return { response, fetched }
}

describe("serveAppPage", () => {
  for (const path of MOBILE_PATHS) {
    test(`a phone opening ${path} gets the mobile build`, async () => {
      for (const ua of [PHONE, ANDROID_PHONE]) {
        const { response, fetched } = await serve(path, { ua })
        expect(fetched).toEqual(["/m/"])
        expect(response.headers.get("vary")).toBe("Accept-Encoding, User-Agent")
      }
    })

    test(`a desktop or tablet opening ${path} gets the SPA`, async () => {
      for (const ua of [DESKTOP, ANDROID_TABLET, undefined]) {
        const { response, fetched } = await serve(path, { ua })
        expect(fetched).toEqual([path])
        expect(response.headers.get("vary")).toBe("Accept-Encoding, User-Agent")
      }
    })
  }

  test("pages the mobile app has no screen for stay on the SPA for phones", async () => {
    for (const path of ["/pair", "/login", "/c/a/b", "/settings/a/b", "/unknown"]) {
      const { response, fetched } = await serve(path, { ua: PHONE })
      expect(fetched).toEqual([path])
      expect(response.headers.get("vary")).toBe("Accept-Encoding")
    }
  })

  test("non-page requests from phones pass through unchanged", async () => {
    for (const init of [{ accept: "application/json" }, { accept: "*/*" }, { method: "HEAD" }, { method: "POST" }]) {
      const { response, fetched } = await serve("/c/abc", { ua: PHONE, ...init })
      expect(fetched).toEqual(["/c/abc"])
      expect(response.headers.get("vary")).toBe("Accept-Encoding")
    }
  })

  test("the public site hosts keep their pages for phones", async () => {
    for (const host of ["kestrel-agent.com", "www.kestrel-agent.com"]) {
      const { response, fetched } = await serve("/", { ua: PHONE, host })
      expect(fetched).toEqual(["/"])
      expect(response.headers.get("vary")).toBe("Accept-Encoding")
    }
  })
})

describe("wrangler.jsonc run_worker_first", () => {
  // Paths that never are pages: the Worker's own routes.
  const NON_PAGE: Record<string, true> = { "/api/*": true, "/auth/*": true, "/box/*": true, "/nest/*": true, "/webhooks/*": true, "/_preview/*": true }

  async function workerFirst(): Promise<string[]> {
    const text = await Bun.file(new URL("../wrangler.jsonc", import.meta.url)).text()
    const config = Bun.JSONC.parse(text) as { assets: { run_worker_first: string[] } }
    return config.assets.run_worker_first
  }

  const matches = (pattern: string, path: string) =>
    new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`).test(path)

  test("every mobile page runs the Worker first", async () => {
    const patterns = await workerFirst()
    for (const path of MOBILE_PATHS) {
      expect(MOBILE_PAGE.test(path)).toBe(true)
      expect(patterns.some((pattern) => matches(pattern, path))).toBe(true)
    }
  })

  test("the Nest host socket runs the Worker first", async () => {
    expect((await workerFirst()).some((pattern) => matches(pattern, "/nest/hosts/connect"))).toBe(true)
  })

  test("every Worker-first page route is a mobile page", async () => {
    for (const pattern of (await workerFirst()).filter((p) => !NON_PAGE[p])) {
      expect(MOBILE_PAGE.test(pattern.replace(/\*/g, "x"))).toBe(true)
    }
  })
})
