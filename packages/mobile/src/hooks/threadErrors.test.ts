import { describe, expect, test } from "bun:test";
import { ApiError } from "@/api/errors";
import { threadErrors } from "./threadErrors";

type Snapshot = { data: unknown; error: unknown };

const loaded = (data: unknown, error?: unknown): Snapshot => ({ data, error });
const offline = () => new ApiError(503, "agent box is not connected", "BoxOffline");

describe("threadErrors", () => {
  test("a cold transport failure is an inline load failure, never an empty chat or a banner", () => {
    const unreachable = new ApiError(0, "Cannot reach server at https://control.example");
    const result = threadErrors([
      loaded(undefined, unreachable),
      loaded(undefined, unreachable),
      loaded(undefined, unreachable),
    ], false, false);
    expect(result.error).toBeNull();
    expect(result.loadError).toBe(
      "Could not load this conversation. Cannot reach server at https://control.example"
    );
  });

  test("a tagged relay failure with no cached content is visible inline", () => {
    const result = threadErrors([loaded(undefined, offline()), loaded(undefined), loaded(undefined)], false, false);
    expect(result.error).toBeNull();
    expect(result.loadError).toBe("Could not load this conversation. agent box is not connected");
  });

  test("a tagged relay failure over cached idle content stays quiet", () => {
    const result = threadErrors([
      loaded({ id: "task" }, offline()),
      loaded([], offline()),
      loaded([], offline()),
    ], false, false);
    expect(result).toEqual({ loadError: null, error: null });
  });

  test("a cached transport failure still warns while the active turn is interrupted", () => {
    const result = threadErrors([
      loaded({ id: "task" }, new ApiError(0, "Cannot reach server")),
      loaded([], new ApiError(0, "Cannot reach server")),
      loaded([{ id: "run", status: "running" }], new ApiError(0, "Cannot reach server")),
    ], true, true);
    expect(result.error).toBe("The connection to this turn's box was lost. Reconnecting…");
    expect(result.loadError).toBeNull();
  });

  test("an application 502 is shown even with cached content", () => {
    const failure = new ApiError(502, "Upstream provider failed", "BadGateway");
    const result = threadErrors([loaded({ id: "task" }), loaded([], failure), loaded([])], false, false);
    expect(result).toEqual({ loadError: null, error: "Upstream provider failed" });
  });

  test("an application 503 is shown even with cached content", () => {
    const failure = new ApiError(503, "Storage unavailable", "StorageUnavailable");
    const result = threadErrors([loaded({ id: "task" }, failure), loaded([]), loaded([])], false, false);
    expect(result).toEqual({ loadError: null, error: "Storage unavailable" });
  });

  test("an actionable query error later in the list is not masked by an earlier transport failure", () => {
    const result = threadErrors([
      loaded(undefined, new ApiError(0, "Cannot reach server")),
      loaded([], new ApiError(500, "Message store failed")),
      loaded([]),
    ], false, false);
    expect(result.error).toBeNull();
    expect(result.loadError).toBe("Could not load this conversation. Message store failed");
  });

  test("a cold transport failure yields to an actionable failure that has data", () => {
    const result = threadErrors([
      loaded({ id: "task" }),
      loaded(undefined, offline()),
      loaded([], new ApiError(500, "Runs are unavailable")),
    ], false, false);
    expect(result.error).toBeNull();
    expect(result.loadError).toBe("Could not load this conversation. Runs are unavailable");
  });

  test("an actionable warning beats the disconnect warning", () => {
    const result = threadErrors([loaded({ id: "task" }), loaded([], new ApiError(500, "Message store failed")), loaded([])], true, true);
    expect(result).toEqual({ loadError: null, error: "Message store failed" });
  });

  test("no failures leave the thread quiet", () => {
    expect(threadErrors([loaded({ id: "task" }), loaded([]), loaded([])], false, false)).toEqual({
      loadError: null,
      error: null,
    });
  });
});
