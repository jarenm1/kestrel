import { Effect, Schema } from "effect"
import { createHash } from "node:crypto"
import { mkdir, readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { DEFAULT_THREAD_SETTINGS, InternalError, ThreadSettings } from "@cloudagents/protocol"
import { writeAtomic } from "./atomic"

/** Identities are hashed: a GitHub login is never a filesystem path here. */
const settingsFile = (dataDir: string, user: string) =>
  join(dataDir, "thread-settings", `${createHash("sha256").update(user).digest("hex")}.json`)

export const readThreadSettings = (dataDir: string, user: string): Effect.Effect<ThreadSettings, InternalError> =>
  Effect.tryPromise({
    try: () => readFile(settingsFile(dataDir, user), "utf8"),
    catch: (error) => error,
  }).pipe(
    Effect.catchAll((error) =>
      (error as NodeJS.ErrnoException).code === "ENOENT"
        ? Effect.succeed(JSON.stringify(DEFAULT_THREAD_SETTINGS))
        : Effect.fail(new InternalError({ message: "cannot read thread settings" })),
    ),
    Effect.flatMap((json) =>
      Schema.decodeUnknown(Schema.parseJson(ThreadSettings))(json).pipe(
        // A file written by a later version must not stop every run from arming: defaults are the safe fallback.
        Effect.catchAll(() => Effect.succeed(DEFAULT_THREAD_SETTINGS)),
      ),
    ),
  )

export const writeThreadSettings = (
  dataDir: string,
  user: string,
  settings: ThreadSettings,
): Effect.Effect<ThreadSettings, InternalError> =>
  Effect.tryPromise({
    try: async () => {
      const file = settingsFile(dataDir, user)
      await mkdir(dirname(file), { recursive: true })
      await writeAtomic(file, JSON.stringify(settings))
      return settings
    },
    catch: () => new InternalError({ message: "cannot save thread settings" }),
  })
