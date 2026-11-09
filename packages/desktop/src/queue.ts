export type SerialQueue = (task: () => Promise<void>) => Promise<void>

/**
 * Runs tasks one at a time in submission order. The sign-in callback and the logout both persist the same session
 * file and the proxy's in-memory copy, so they must not overlap: a callback that finishes while a logout is still
 * clearing would be rolled back, and a logout that finishes last would drop a session the callback just stored.
 *
 * A failing task is reported and does not wedge the queue; the caller still sees its own rejection through the
 * returned promise.
 */
export const createSerialQueue = (onError: (error: unknown) => void): SerialQueue => {
  let tail: Promise<void> = Promise.resolve()
  return (task) => {
    tail = tail.then(task).catch(onError)
    return tail
  }
}
