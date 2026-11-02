/**
 * The web build is served by the app host itself, so the session is its HttpOnly `session` cookie: the browser sends
 * it on same-origin requests (and forbids setting a `Cookie` header), and direct boxes take a bearer token instead.
 */
export const fetchCredentials: RequestCredentials = "same-origin";

/** The control plane this build is served from. */
export const hostOrigin: string | null = window.location.origin;
