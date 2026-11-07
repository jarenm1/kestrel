import { describe, expect, test } from "bun:test";
import { ApiError, isUnreachableError, responseError } from "./errors";

describe("responseError", () => {
  test("keeps the server's error tag beside its message", () => {
    const error = responseError(503, JSON.stringify({ _tag: "BoxOffline", message: "agent box unreachable" }), "Service Unavailable");
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(503);
    expect(error.tag).toBe("BoxOffline");
    expect(error.message).toBe("agent box unreachable");
  });

  test("a tagged failure without a message still reads as text, with the tag kept", () => {
    const error = responseError(502, JSON.stringify({ _tag: "BoxOffline" }), "Bad Gateway");
    expect(error.tag).toBe("BoxOffline");
    expect(error.message).toBe(JSON.stringify({ _tag: "BoxOffline" }));
  });

  test("a non-JSON failure keeps the response text and no tag", () => {
    const error = responseError(500, "plain failure", "Internal Server Error");
    expect(error.message).toBe("plain failure");
    expect(error.tag).toBeUndefined();
  });

  test("an empty failure falls back to the status text", () => {
    const error = responseError(504, "", "Gateway Timeout");
    expect(error.message).toBe("Gateway Timeout");
    expect(error.tag).toBeUndefined();
  });
});

describe("isUnreachableError", () => {
  test("a failed connection is transport", () => {
    expect(isUnreachableError(new ApiError(0, "Cannot reach server"))).toBe(true);
  });

  test("only the control plane's BoxOffline tag makes a gateway failure transport", () => {
    for (const status of [502, 503, 504]) {
      const offline = responseError(status, JSON.stringify({ _tag: "BoxOffline", message: "agent box unreachable" }), "");
      expect(isUnreachableError(offline)).toBe(true);
    }
  });

  test("a bare gateway status is never transport", () => {
    for (const status of [502, 503, 504]) {
      expect(isUnreachableError(new ApiError(status, "Bad Gateway"))).toBe(false);
    }
  });

  test("an application failure is not hidden by its status, even at a gateway code", () => {
    for (const status of [502, 503]) {
      const error = responseError(status, JSON.stringify({ _tag: "BadGateway", message: "upstream failed" }), "");
      expect(isUnreachableError(error)).toBe(false);
      expect(error.message).toBe("upstream failed");
    }
  });

  test("a BoxOffline tag outside the gateway statuses is still an application failure", () => {
    const error = responseError(500, JSON.stringify({ _tag: "BoxOffline", message: "internal" }), "");
    expect(isUnreachableError(error)).toBe(false);
  });

  test("non-ApiError failures are not transport", () => {
    expect(isUnreachableError(new Error("network"))).toBe(false);
    expect(isUnreachableError("network")).toBe(false);
  });
});
