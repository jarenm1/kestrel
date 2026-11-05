/// <reference types="bun" />
import { expect, test } from "bun:test";
import type { TextGenerationSettings, ThreadSettings } from "@cloudagents/protocol";
import { createApiClient } from "./client";

const textGeneration: TextGenerationSettings = {
  enabled: true,
  model: "claude-opus-5-5",
  effort: "high",
  threadTitleInstructions: "Name the subject first.",
  responseStreamingMode: "paragraph",
};

const thread: ThreadSettings = { autoResumeAfterUsageLimits: true };

test("settings reads and writes take the selected box's token and decode through the protocol schema", async () => {
  const seen: string[] = [];
  let origin = "";
  const box = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const authorization = request.headers.get("authorization") ?? "";
      if (authorization !== "Bearer box-token") return Response.json({ message: "forbidden" }, { status: 401 });
      seen.push(`${request.method} ${url.pathname}`);
      if (url.pathname === "/api/settings/text-generation") {
        return Response.json(request.method === "PUT" ? await request.json() : textGeneration);
      }
      if (url.pathname === "/api/settings/threads") {
        return Response.json(request.method === "PUT" ? await request.json() : thread);
      }
      return new Response(null, { status: 404 });
    },
  });
  origin = box.url.origin;
  const control = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/api/boxes/box/token") {
        return Response.json({ token: "box-token", url: origin, expiresAt: "2099-01-01T00:00:00Z" });
      }
      return new Response(null, { status: 404 });
    },
  });
  try {
    const client = createApiClient(control.url.origin, "session", { id: "box", url: origin });
    expect(await client.textGenerationSettings()).toEqual(textGeneration);
    expect(await client.saveTextGenerationSettings({
      ...textGeneration,
      model: null,
      effort: null,
      threadTitleInstructions: "",
      responseStreamingMode: "turn",
    })).toEqual({
      ...textGeneration,
      model: null,
      effort: null,
      threadTitleInstructions: "",
      responseStreamingMode: "turn",
    });
    expect(await client.threadSettings()).toEqual(thread);
    expect(await client.saveThreadSettings({ autoResumeAfterUsageLimits: false })).toEqual({
      autoResumeAfterUsageLimits: false,
    });
    expect(seen).toEqual([
      "GET /api/settings/text-generation",
      "PUT /api/settings/text-generation",
      "GET /api/settings/threads",
      "PUT /api/settings/threads",
    ]);
  } finally {
    control.stop(true);
    box.stop(true);
  }
});

test("a settings response with an unsupported thinking level is rejected instead of trusted", async () => {
  let origin = "";
  const box = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/api/settings/text-generation") {
        // Haiku 4.5 lists no thinking levels, so the protocol's own check must refuse this snapshot.
        return Response.json({ ...textGeneration, model: "claude-haiku-4-5", effort: "max" });
      }
      if (url.pathname === "/api/boxes/box/token") {
        return Response.json({ token: "box-token", url: origin, expiresAt: "2099-01-01T00:00:00Z" });
      }
      return new Response(null, { status: 404 });
    },
  });
  origin = box.url.origin;
  try {
    const client = createApiClient(origin, "session", { id: "box", url: origin });
    await expect(client.textGenerationSettings()).rejects.toMatchObject({
      status: 200,
      message: expect.stringContaining("Unexpected response shape"),
    });
  } finally {
    box.stop(true);
  }
});

test("relayed settings use the session cookie and keep the control plane path", async () => {
  const seen: string[] = [];
  const control = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      seen.push(`${request.method} ${url.pathname} cookie=${request.headers.get("cookie")} bearer=${request.headers.get("authorization")}`);
      if (url.pathname === "/api/settings/text-generation") {
        return Response.json(request.method === "PUT" ? await request.json() : textGeneration);
      }
      return new Response(null, { status: 404 });
    },
  });
  try {
    const client = createApiClient(control.url.origin, "session", null);
    expect(await client.textGenerationSettings()).toEqual(textGeneration);
    await client.saveTextGenerationSettings(textGeneration);
    expect(seen).toEqual([
      "GET /api/settings/text-generation cookie=session=session bearer=null",
      "PUT /api/settings/text-generation cookie=session=session bearer=null",
    ]);
  } finally {
    control.stop(true);
  }
});
