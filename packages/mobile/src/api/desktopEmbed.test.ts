/// <reference types="bun" />
import { expect, test } from "bun:test";
import { createApiClient } from "./client";

test("desktop embed URL is the app host's embed page, with the ws URL and task in the fragment", () => {
  const client = createApiClient("https://app.example", null, null);
  const ws = "wss://box.example/api/tasks/task%201/desktop/stream?access_token=a+b&x=1";
  const url = new URL(client.desktopEmbedUrl("task 1", ws));
  expect(`${url.origin}${url.pathname}`).toBe("https://app.example/embed/desktop");
  const fragment = new URLSearchParams(url.hash.slice(1));
  expect(fragment.get("ws")).toBe(ws);
  expect(fragment.get("task")).toBe("task 1");
});

test("desktopSocketUrl with no box fails cleanly instead of minting a control-plane token", async () => {
  const client = createApiClient("https://control.example", "session", null);
  await expect(client.desktopSocketUrl("t1")).rejects.toThrow("no box is available");
});

test("desktopSocketUrl on a user box reuses the minted box token, and mints a new one when asked for a fresh URL", async () => {
  let mints = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request: Request) {
      if (request.method !== "POST" || new URL(request.url).pathname !== "/api/boxes/box-1/token") {
        return new Response(null, { status: 404 });
      }
      mints += 1;
      return Response.json({
        token: `token-${mints}`,
        url: new URL(request.url).origin,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      });
    },
  });
  try {
    const client = createApiClient(server.url.origin, "session", { id: "box-1", url: server.url.origin });
    const tokenOf = async (options?: { fresh?: boolean }) =>
      [...new URL(await client.desktopSocketUrl("t", options)).searchParams.values()][0];
    expect(await tokenOf()).toBe("token-1");
    expect(await tokenOf()).toBe("token-1");
    expect(await tokenOf({ fresh: true })).toBe("token-2");
    expect(mints).toBe(2);
  } finally {
    await server.stop(true);
  }
});
