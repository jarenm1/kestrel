import { Effect, Schema } from "effect"
import { createHash } from "node:crypto"
import { mkdir, readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { DEFAULT_TEXT_GENERATION_SETTINGS, InternalError, TextGenerationSettings } from "@cloudagents/protocol"
import { writeAtomic } from "./atomic"

// Hash identities rather than treating an authenticated login as a filesystem path.
const settingsFile = (dataDir: string, user: string) =>
  join(dataDir, "text-generation", `${createHash("sha256").update(user).digest("hex")}.json`)

export const readTextGenerationSettings = (dataDir: string, user: string): Effect.Effect<TextGenerationSettings, InternalError> =>
  Effect.tryPromise({
    try: () => readFile(settingsFile(dataDir, user), "utf8"),
    catch: (error) => error,
  }).pipe(
    Effect.catchAll((error) =>
      (error as NodeJS.ErrnoException).code === "ENOENT"
        ? Effect.succeed(JSON.stringify(DEFAULT_TEXT_GENERATION_SETTINGS))
        : Effect.fail(new InternalError({ message: "cannot read text generation settings" })),
    ),
    Effect.flatMap((json) => Schema.decodeUnknown(Schema.parseJson(TextGenerationSettings))(json).pipe(
      Effect.mapError(() => new InternalError({ message: "invalid saved text generation settings" })),
    )),
  )

export const writeTextGenerationSettings = (
  dataDir: string,
  user: string,
  settings: TextGenerationSettings,
): Effect.Effect<TextGenerationSettings, InternalError> =>
  Effect.tryPromise({
    try: async () => {
      const file = settingsFile(dataDir, user)
      await mkdir(dirname(file), { recursive: true })
      await writeAtomic(file, JSON.stringify(settings))
      return settings
    },
    catch: () => new InternalError({ message: "cannot save text generation settings" }),
  })
