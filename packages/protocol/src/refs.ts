import { Schema } from "effect"

/**
 * A github.com repository as "owner/name". The name may not be `.` or `..`, so it can never step out of a path
 * (mirror directories, API URLs).
 */
export const GithubRepoSlug = Schema.String.pipe(
  Schema.pattern(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/),
)
export type GithubRepoSlug = typeof GithubRepoSlug.Type

/**
 * What a checkout names: a GitHub "owner/name" or an `https://` clone URL without credentials. Agents supply it
 * (`repo_checkout`) and the host hands it to git, so local paths, `file://`, `ext::` and every other transport are
 * rejected here.
 */
export const RepoRef = Schema.Union(GithubRepoSlug, Schema.String.pipe(Schema.pattern(/^https:\/\/[^\s@/]+\/[^\s@]+$/)))
export type RepoRef = typeof RepoRef.Type

/**
 * A branch name as git accepts it (see git-check-ref-format), restricted to characters that can never read as an
 * option or a refspec: no leading `-`, no `..`, `//`, `@{`, `:`, spaces, or a trailing `/` or `.lock`.
 */
export const BranchName = Schema.String.pipe(
  Schema.pattern(/^(?![-/.])(?!.*\.\.)(?!.*\/\/)(?!.*\/\.)(?!.*@\{)[A-Za-z0-9._/-]+(?<![/.])(?<!\.lock)$/),
)
export type BranchName = typeof BranchName.Type
