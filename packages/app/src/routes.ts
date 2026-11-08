/**
 * One build serves two hosts:
 * - the public site (`kestrel-agent.com`, `www.`; locally `site.localhost:<port>`): landing at `/`, pricing at `/pricing`, waitlist at `/waitlist`;
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

const LOOPBACK_HOSTS: Record<string, true> = {
  localhost: true,
  "127.0.0.1": true,
  "::1": true,
  "[::1]": true,
}

/**
 * Origin for links meant for other people. The desktop app serves the built app from loopback, so its links have to
 * name the public app instead; a local dev server still shares links that point at itself.
 */
export const SHARE_ORIGIN =
  LOOPBACK_HOSTS[hostname] === true && !import.meta.env.DEV ? "https://app.kestrel-agent.com" : APP_ORIGIN

export const threadPath = (taskId: string) => `/c/${taskId}`
