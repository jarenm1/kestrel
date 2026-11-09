/**
 * Durable TURN generations in the Hub. `/box/turn` is served by the Worker, which caches credentials per box; the Hub
 * owns the durable state. Bumping a box's generation on secret rotation or deletion changes the identity the Worker
 * hashes into its cache key, so a warm Worker isolate cannot serve credentials minted for the old identity.
 */

/** The slice of `SqlStorage` the generation table needs. */
export interface TurnGenerationsSql {
  exec<T extends Record<string, string | number | null>>(
    query: string,
    ...bindings: (string | number | null)[]
  ): { toArray(): T[] }
}

export const ensureTurnGenerationsTable = (sql: TurnGenerationsSql): void => {
  sql.exec(`CREATE TABLE IF NOT EXISTS turn_generations (
    identity TEXT PRIMARY KEY,
    generation INTEGER NOT NULL
  )`)
}

/** The box's current generation; a box that was never rotated or deleted is generation 0. */
export const turnGeneration = (sql: TurnGenerationsSql, identity: string): number =>
  sql
    .exec<{ generation: number }>("SELECT generation FROM turn_generations WHERE identity = ?", identity)
    .toArray()[0]?.generation ?? 0

/** Advances a box's generation; the tombstone is kept after deletion so a reused id still misses warm caches. */
export const bumpTurnGeneration = (sql: TurnGenerationsSql, identity: string): number => {
  sql.exec(
    `INSERT INTO turn_generations (identity, generation) VALUES (?, 1)
     ON CONFLICT(identity) DO UPDATE SET generation = generation + 1`,
    identity,
  )
  return turnGeneration(sql, identity)
}
