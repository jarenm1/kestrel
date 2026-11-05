/**
 * A message from an HTML page to the host. Pages post JSON strings (`ReactNativeWebView.postMessage`) or objects
 * (`parent.postMessage`); both come back as the parsed value. Anything that is not JSON is passed through as a string.
 */
export function parseHtmlMessage(data: unknown): unknown {
  if (typeof data !== "string") return data;
  try {
    return JSON.parse(data);
  } catch {
    return data;
  }
}
