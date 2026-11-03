/// <reference types="bun" />
import { expect, test } from "bun:test";
import { createApiClient } from "./client";
import { sessionCookieScript } from "./embedCookie";

/** Runs a cookie script against a stand-in `document` and returns the cookie string it assigned. */
function runCookieScript(script: string): string {
  const doc = { cookie: "" };
  const run = new Function("document", script) as (document: { cookie: string }) => unknown;
  run(doc);
  return doc.cookie;
}

test("the cookie script sets the session cookie for http, without the secure flag", () => {
  expect(runCookieScript(sessionCookieScript("http://192.168.1.5:8787", "ab12"))).toBe(
    "session=ab12; path=/; samesite=lax"
  );
});

test("the cookie script adds the secure flag for https servers", () => {
  expect(runCookieScript(sessionCookieScript("https://app.example", "ab12"))).toBe(
    "session=ab12; path=/; samesite=lax; secure"
  );
});

test("the cookie script escapes its literal and encodes the value, whatever characters they hold", () => {
  const value = 'x"\\\'\u2028\u2029\n</script>';
  const script = sessionCookieScript("https://app.example", value);
  expect(runCookieScript(script)).toBe(
    `session=${encodeURIComponent(value)}; path=/; samesite=lax; secure`
  );
  expect(script).not.toContain("\u2028");
  expect(script).not.toContain("\u2029");
});

test("the client gives the cookie script for Kestrel's relayed box only", () => {
  const relayed = createApiClient("https://app.example", "ab12", null).embedCookieScript();
  expect(relayed).toBe(sessionCookieScript("https://app.example", "ab12"));

  const direct = createApiClient("https://app.example", "ab12", { id: "box-1", url: "https://box.example" });
  expect(direct.embedCookieScript()).toBeNull();

  expect(createApiClient("https://app.example", null, null).embedCookieScript()).toBeNull();
});
