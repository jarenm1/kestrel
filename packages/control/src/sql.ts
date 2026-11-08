/** The slice of `SqlStorage` the control-plane tables need. */
export interface FleetSql {
  exec<T extends Record<string, string | number | null>>(
    query: string,
    ...bindings: (string | number | null)[]
  ): { toArray(): T[] }
}
