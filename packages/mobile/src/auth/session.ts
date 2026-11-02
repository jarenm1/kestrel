/**
 * How requests carry the session. Native: the session id is saved in SecureStore and sent as an explicit `Cookie`
 * header, and `credentials: "omit"` keeps React Native from merging the WebView cookie jar into it (a comma-joined,
 * invalid session). The web build uses `session.web.ts`.
 */
export const fetchCredentials: RequestCredentials = "omit";

/** The control plane this build is served from; `null` when the user picks a server URL (native). */
export const hostOrigin: string | null = null;
