/** An HTTP failure with the server's error kind kept separate from its message. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly tag?: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Preserves the server's error kind: an HTTP gateway status alone does not establish box connectivity. */
export function responseError(status: number, text: string, fallback: string): ApiError {
  try {
    const body: unknown = JSON.parse(text);
    if (typeof body === "object" && body !== null) {
      const message = "message" in body && typeof body.message === "string" ? body.message : text || fallback;
      const tag = "_tag" in body && typeof body._tag === "string" ? body._tag : undefined;
      return new ApiError(status, message, tag);
    }
  } catch {
    // Not JSON; fall through to the raw text.
  }
  return new ApiError(status, text || fallback);
}

/** True only for a failure of transport: a failed connection or a relayed box the control plane explicitly reports down. */
export function isUnreachableError(error: unknown): boolean {
  return error instanceof ApiError && (
    error.status === 0 || (error.tag === "BoxOffline" && [502, 503, 504].includes(error.status))
  );
}
