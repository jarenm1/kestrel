/**
 * The marketing hosts serve only the app's public pages. Sessions live on the app host, so sign-in and API calls
 * that land here (e.g. an old bookmark) move there with the same path.
 */
export const SITE_HOSTS: Record<string, true> = { "kestrel-agent.com": true, "www.kestrel-agent.com": true }

/** Phones' browsers: `Mobi` is in every phone browser's user agent and in no tablet's or desktop's. */
const PHONE_USER_AGENT = /Mobi/

/**
 * App pages the mobile app has a screen for: home, threads and settings (automations and archived threads included).
 * They are also the Worker-first page routes in wrangler.jsonc (pages.test.ts checks the two agree). Other pages
 * (pairing approval, sign-in) stay on the desktop SPA.
 */
export const MOBILE_PAGE = /^\/(?:c\/[^/]+|settings(?:\/[^/]+)?)?\/?$/

/**
 * App pages that moved: old path pattern and the new path for a match, first match wins. Answered with a permanent
 * redirect before any app loads, so bookmarks and saved links reach the new URL on every client and the apps keep no
 * routes for old paths. Each is a Worker-first route in wrangler.jsonc (pages.test.ts checks it). Thread ids stay as
 * they were encoded in the old path.
 */
const MOVED_PAGES: readonly (readonly [RegExp, (match: RegExpExecArray) => string])[] = [
  [/^\/automations\/?$/, () => "/settings/automations"],
  [/^\/archived\/?$/, () => "/settings/archived"],
  // Threads before threads lived at `/c/:id`, first by task, then per repository.
  [/^\/tasks\/([^/]+)\/?$/, ([, taskId]) => `/c/${taskId}`],
  [/^\/repos\/[^/]+\/threads\/([^/]+)\/?$/, ([, taskId]) => `/c/${taskId}`],
  // Any other page of the old per-repository layout.
  [/^\/repos(?:\/.*)?$/, () => "/"],
]

/** The new path of a moved page, or null when `path` did not move. */
export const movedPage = (path: string): string | null => {
  for (const [from, to] of MOVED_PAGES) {
    const match = from.exec(path)
    if (match) return to(match)
  }
  return null
}

/** The static asset server (`env.ASSETS`). */
export interface Assets {
  fetch(request: Request): Promise<Response>
}

/**
 * The app host serves phones the mobile app's web build (`packages/mobile`, exported to `/m/`) in place of the desktop
 * SPA, on the same URLs: the mobile app opens the screen for the path itself. The site hosts' public pages stay.
 */
export const serveAppPage = async (request: Request, assets: Assets, url: URL): Promise<Response> => {
  const moved = movedPage(url.pathname)
  if (moved !== null && (request.method === "GET" || request.method === "HEAD")) {
    return Response.redirect(new URL(`${moved}${url.search}`, url).toString(), 301)
  }
  const page =
    request.method === "GET" &&
    !SITE_HOSTS[url.hostname] &&
    MOBILE_PAGE.test(url.pathname) &&
    (request.headers.get("accept") ?? "").includes("text/html")
  if (!page) return assets.fetch(request)
  const phone = PHONE_USER_AGENT.test(request.headers.get("user-agent") ?? "")
  const response = await assets.fetch(phone ? new Request(new URL("/m/", url), request) : request)
  const headers = new Headers(response.headers)
  headers.append("Vary", "User-Agent")
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}
