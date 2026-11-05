import { Effect, Either } from "effect"
import type { CoreShape } from "../core/service"
import type { GhBackend } from "./context"

/** Runs a core call for the shim; its failure becomes an Error carrying the core's message. */
const call = async <A>(effect: Effect.Effect<A, { readonly message: string }>): Promise<A> => {
  const result = await Effect.runPromise(Effect.either(effect))
  if (Either.isLeft(result)) throw new Error(result.left.message)
  return result.right
}

/** The shim's backend for one thread: core's checkout-scoped GitHub operations, token host-side. */
export const coreGhBackend = (core: CoreShape, taskId: string): GhBackend => ({
  checkouts: () => call(core.ghCheckouts(taskId)),
  graphql: (checkoutId, query, variables) => call(core.githubGraphql(taskId, checkoutId, query, variables)),
  pullRequestDiff: (checkoutId, number, format) => call(core.pullRequestDiff(taskId, checkoutId, number, format)),
  commitLog: (checkoutId) => call(core.checkoutCommitLog(taskId, checkoutId)),
  openPullRequest: (input) => call(core.openPullRequest(taskId, input)),
  updatePullRequest: (input) => call(core.updatePullRequest(taskId, input)),
  comment: (input) =>
    call(
      Effect.flatMap(core.commentOnPullRequest(taskId, { checkoutId: input.checkoutId, number: input.number, action: "create", body: input.body }), (posted) =>
        posted === null ? Effect.die("a created comment is never null") : Effect.succeed(posted),
      ),
    ),
  review: (input) => call(core.reviewPullRequest(taskId, input)),
  changeReviewers: (input) => call(core.changeReviewers(taskId, input)),
  changeLabels: (input) => call(core.changeLabels(taskId, input)),
  api: (request) => call(core.githubApi(taskId, request)),
})
