import { Kind, parse } from "graphql"

/**
 * What an agent's `gh api` may send with the thread owner's token: reads only. REST requests must be GET or HEAD
 * without a body; the one POST allowed is to `graphql` with a document whose every operation is a query. Writes go
 * through the `github_*` tools, which scope them to the thread's checkouts.
 */

/** Headers an agent's request cannot set: the box sends the credential, and these would change the method GitHub runs. */
const METHOD_OVERRIDES: Record<string, true> = { "x-http-method-override": true, "x-http-method": true, "x-method-override": true }

const WRITE_REFUSAL = "use the github_* tools to change GitHub"

/** Why `gh api` refuses a request, or null when it is a read. `path` is the endpoint argument (`graphql` for v4). */
export const readOnlyRefusal = (
  method: string,
  path: string,
  headers: ReadonlyArray<readonly [string, string]>,
  body: string | null,
): string | null => {
  for (const [name] of headers) {
    if (METHOD_OVERRIDES[name.toLowerCase()]) return `the ${name} header is not available in Kestrel's gh api`
  }
  const verb = method.toUpperCase()
  if (verb === "GET" || verb === "HEAD") {
    return body === null ? null : `gh api in Kestrel sends ${verb} requests without a body`
  }
  if (verb !== "POST" || path !== "graphql") {
    return `gh api in Kestrel is read-only: ${verb} ${path} is not sent; ${WRITE_REFUSAL}`
  }
  return graphqlRefusal(body)
}

/** A GraphQL request body is read-only when it is one JSON object whose `query` holds queries only. */
const graphqlRefusal = (body: string | null): string | null => {
  let request: unknown
  try {
    request = body === null ? null : JSON.parse(body)
  } catch {
    return "gh api in Kestrel sends GraphQL requests only as a JSON object with a query"
  }
  if (request === null || typeof request !== "object" || Array.isArray(request)) {
    return "gh api in Kestrel sends GraphQL requests only as a JSON object with a query"
  }
  const query = "query" in request ? request.query : undefined
  if (typeof query !== "string") return "gh api graphql needs a query (-f query=...)"
  let document
  try {
    document = parse(query)
  } catch (error) {
    return `gh api in Kestrel could not parse the GraphQL query: ${error instanceof Error ? error.message : String(error)}`
  }
  for (const definition of document.definitions) {
    if (definition.kind === Kind.OPERATION_DEFINITION && definition.operation !== "query") {
      return `gh api in Kestrel is read-only: GraphQL ${definition.operation}s are not sent; ${WRITE_REFUSAL}`
    }
  }
  return null
}
