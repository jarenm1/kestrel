/**
 * A script that sets the app's session cookie in the native desktop WebView's jar, run before the embed page loads.
 * The embed page is served from the server's origin, and its WebSocket to a relayed box is authenticated by the
 * `session` cookie; the native request headers do not reach the WebView, so the cookie has to be set in the page.
 * The value is hex (control `randomToken`), so `encodeURIComponent` leaves it unchanged.
 */
export function sessionCookieScript(serverUrl: string, sessionCookie: string): string {
  const secure = /^https:/i.test(serverUrl) ? "; secure" : "";
  const cookie = `session=${encodeURIComponent(sessionCookie)}; path=/; samesite=lax${secure}`;
  // JSON leaves U+2028/U+2029 raw; older JavaScript engines reject them inside string literals.
  const literal = JSON.stringify(cookie).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  return `document.cookie = ${literal}; true;`;
}
