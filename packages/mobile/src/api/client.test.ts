/// <reference types="bun" />
import { expect, spyOn, test } from "bun:test";
import { createApiClient } from "./client";

/**
 * iOS RCTNetworking seeds headers from its shared cookie jar when withCredentials is true, then appends explicit
 * headers. Emulate that transport step around real HTTP requests; a duplicate session is not a valid session id.
 */
test("saved session authenticates and logs out even when the WebView cookie jar also has a session", async () => {
  const user = { login: "mobile-user", name: null, avatarUrl: "" };
  let sessionExists = true;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (request.headers.get("cookie") !== "session=saved-session" || !sessionExists) {
        return Response.json({ message: "sign in required" }, { status: 401 });
      }
      if (new URL(request.url).pathname === "/auth/logout") {
        sessionExists = false;
        return new Response(null, { status: 204 });
      }
      return Response.json(user);
    },
  });
  const networkFetch = globalThis.fetch;
  const nativeCookieFetch: typeof fetch = Object.assign(
    (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers();
      if (init?.credentials !== "omit") headers.set("Cookie", "session=saved-session");
      new Headers(init?.headers).forEach((value, name) => headers.append(name, value));
      return networkFetch(input, { ...init, headers });
    },
    { preconnect: networkFetch.preconnect }
  );
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(nativeCookieFetch);
  try {
    const client = createApiClient(server.url.origin, "saved-session");
    expect(await client.me()).toEqual(user);
    await client.logout();
    await expect(client.me()).rejects.toMatchObject({ status: 401 });
  } finally {
    fetchSpy.mockRestore();
    await server.stop(true);
  }
});
