export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly tag?: string) {
    super(message)
    this.name = "ApiError"
  }
}

/** Preserve the server's error kind: HTTP gateway status alone does not establish box connectivity. */
export function responseError(status: number, text: string, fallback: string): ApiError {
  try {
    const body: unknown = JSON.parse(text)
    if (typeof body === "object" && body !== null) {
      const message = "message" in body && typeof body.message === "string" ? body.message : text || fallback
      const tag = "_tag" in body && typeof body._tag === "string" ? body._tag : undefined
      return new ApiError(status, message, tag)
    }
  } catch {
    // Non-JSON failures retain their original response text.
  }
  return new ApiError(status, text || fallback)
}

export function isUnreachableError(error: unknown): boolean {
  return error instanceof ApiError && (
    error.status === 0 || (error.tag === "BoxOffline" && [502, 503, 504].includes(error.status))
  )
}
