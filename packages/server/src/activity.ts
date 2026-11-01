import { rmSync, statSync } from "node:fs"
import { createServer, type Server } from "node:http"
import { Effect } from "effect"

/** What box-auto reads to decide whether restarting the box would interrupt work. */
export interface BoxActivity {
  /** Runs that are running, holding a run slot, or waiting for one. */
  readonly runs: number
  /** Desktop sessions that are starting or running. */
  readonly desktops: number
}

/** A Unix socket path holds at most 107 bytes (sun_path is 108 bytes, with its NUL). */
const MAX_SOCKET_PATH_BYTES = 107

/** The socket file is created owner-only: the box's own user is the only one that can ask. */
const SOCKET_UMASK = 0o177

export interface ActivitySocket {
  /** Stops answering and removes the socket file. */
  readonly close: Effect.Effect<void>
}

/** Removes a leftover socket from a process that died without closing it. Any other file is left for listen to reject. */
const removeStaleSocket = (socketPath: string): void => {
  if (statSync(socketPath, { throwIfNoEntry: false })?.isSocket()) rmSync(socketPath, { force: true })
}

const listen = (server: Server, socketPath: string) =>
  Effect.async<void, Error>((resume) => {
    const onError = (error: Error) => resume(Effect.fail(error))
    server.once("error", onError)
    const previous = process.umask(SOCKET_UMASK)
    try {
      server.listen(socketPath, () => {
        server.off("error", onError)
        resume(Effect.void)
      })
    } finally {
      process.umask(previous)
    }
  })

/**
 * Serves `GET /activity` -> `{"runs":n,"desktops":n}` on a Unix socket, for box-auto to defer a restart while the box is
 * busy. Nothing else is served. The socket is an operator-side check only: it is never exposed through the HTTP listener,
 * because a reverse proxy on the same host connects from loopback. Returns null (after a warning) when the socket cannot
 * be opened; the box then runs without it, and box-auto restarts it as it did before the socket existed.
 */
export const openActivitySocket = (
  socketPath: string,
  read: Effect.Effect<BoxActivity>,
): Effect.Effect<ActivitySocket | null> =>
  Effect.gen(function* () {
    if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH_BYTES) {
      yield* Effect.logWarning(`box activity socket skipped: ${socketPath} is too long for a Unix socket path`)
      return null
    }
    const server = createServer((req, res) => {
      if (req.method !== "GET" || new URL(req.url ?? "/", "http://box").pathname !== "/activity") {
        res.statusCode = 404
        res.end()
        return
      }
      Effect.runPromise(read).then(
        (activity) => {
          res.setHeader("content-type", "application/json")
          res.end(JSON.stringify({ runs: activity.runs, desktops: activity.desktops }))
        },
        () => {
          res.statusCode = 500
          res.end()
        },
      )
    })
    const opened = yield* Effect.try({
      try: () => removeStaleSocket(socketPath),
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    }).pipe(
      Effect.zipRight(listen(server, socketPath)),
      Effect.as(true),
      Effect.catchAll((error) =>
        Effect.logWarning(`box activity socket not opened at ${socketPath}: ${error.message}`).pipe(Effect.as(false)),
      ),
    )
    if (!opened) return null
    const close = Effect.async<void>((resume) => {
      server.close(() => {
        rmSync(socketPath, { force: true })
        resume(Effect.void)
      })
      server.closeAllConnections()
    })
    return { close }
  })
