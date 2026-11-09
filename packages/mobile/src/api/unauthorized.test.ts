/// <reference types="bun" />
import { expect, test } from "bun:test";
import { createApiClient, onUnauthorized } from "./client";

test("a control-plane 401 reports an expired session once per refusal", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return Response.json({ message: "session expired" }, { status: 401 });
    },
  });
  let fired = 0;
  const unsubscribe = onUnauthorized(() => {
    fired += 1;
  });
  try {
    const client = createApiClient(server.url.origin, "session", null);
    await expect(client.boxes()).rejects.toMatchObject({ status: 401 });
    expect(fired).toBe(1);
  } finally {
    unsubscribe();
    await server.stop(true);
  }
});

test("a direct box refusing its token is not a session expiry, and it remints once", async () => {
  let mints = 0;
  const accepted = new Set<string>();
  const box = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const token = (request.headers.get("authorization") ?? "").replace("Bearer ", "");
      if (!accepted.has(token)) return Response.json({ message: "token refused" }, { status: 401 });
      return Response.json([]);
    },
  });
  const control = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      mints += 1;
      return Response.json({
        token: `token-${mints}`,
        url: box.url.origin,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      });
    },
  });
  let fired = 0;
  const unsubscribe = onUnauthorized(() => {
    fired += 1;
  });
  try {
    const client = createApiClient(control.url.origin, "session", { id: "box-1", url: box.url.origin });
    // The first mint is refused (the box's secret rotated) and the call remints once rather than surfacing a 401.
    accepted.add("token-2");
    expect(await client.listTasks()).toEqual([]);
    expect(mints).toBe(2);
    // The reminted token is cached for the next call.
    expect(await client.listTasks()).toEqual([]);
    expect(mints).toBe(2);

    accepted.clear();
    accepted.add("token-3");
    expect(await client.listTasks()).toEqual([]);
    expect(mints).toBe(3);
    expect(fired).toBe(0);
  } finally {
    unsubscribe();
    control.stop(true);
    box.stop(true);
  }
});
