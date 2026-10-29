/**
 * One build serves two hosts:
 * - the public site (`kestrel-agent.com`, `www.`; locally `site.localhost:<port>`): landing at `/`, pricing at `/pricing`;
 * - the app (`app.kestrel-agent.com`, workers.dev Previews, `localhost:<port>`): new chat at `/`, threads at `/c/:id`.
 */
const { hostname, protocol, port } = window.location

export const IS_SITE_HOST =
  hostname === "kestrel-agent.com" || hostname === "www.kestrel-agent.com" || hostname.startsWith("site.")

/** Origin of the app; on the public site, links into the app (Get Started, sign-in) go here. */
export const APP_ORIGIN = !IS_SITE_HOST
  ? window.location.origin
  : hostname.startsWith("site.")
    ? `${protocol}//${hostname.slice("site.".length)}${port ? `:${port}` : ""}`
    : "https://app.kestrel-agent.com"

/** Home of the app: the new chat composer. */
export const APP_HOME = "/"

export const threadPath = (taskId: string) => `/c/${taskId}`
