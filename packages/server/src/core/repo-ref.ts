import { Schema } from "effect"
import { GithubRepoSlug, RepoRef as RepoRefSchema } from "@cloudagents/protocol"

/** A repository a thread can check out, normalized from a protocol-validated `RepoRef`. */
export interface RepoRef {
  /** Stored on `Checkout.repo`: `owner/name` on github.com, otherwise the https clone URL. */
  readonly repo: string
  /** Remote URL used for fetch and push. */
  readonly url: string
  /** Mirror path below a user's mirrors directory, e.g. `github.com/owner/name.git`. */
  readonly mirrorRel: string
  /** Default checkout directory name: the repository name. */
  readonly name: string
  /** GitHub owner and name when the repository is on github.com. */
  readonly github: { readonly owner: string; readonly name: string } | null
}

const GITHUB_HOST = "github.com"
/** Path segments of an https clone URL become directories on disk; the protocol does not constrain them. */
const SEGMENT = /^[A-Za-z0-9_.-]+$/

const stripGit = (segment: string): string => (segment.endsWith(".git") ? segment.slice(0, -".git".length) : segment)

const validName = (name: string): boolean => name.length > 0 && name !== "." && name !== ".."

const githubRef = (owner: string, name: string): RepoRef => ({
  repo: `${owner}/${name}`,
  url: `https://${GITHUB_HOST}/${owner}/${name}.git`,
  mirrorRel: `${GITHUB_HOST}/${owner}/${name}.git`,
  name,
  github: { owner, name },
})

/**
 * Normalizes a repository the protocol accepts (`RepoRef`) into a checkout's identity. Only what the protocol cannot
 * express is checked here: ports, queries and fragments, and path segments that cannot be directories.
 * Null when rejected.
 */
export const parseRepoRef = (input: string): RepoRef | null => {
  if (!Schema.is(RepoRefSchema)(input)) return null
  if (Schema.is(GithubRepoSlug)(input)) {
    const [owner, rawName] = input.split("/") as [string, string]
    const name = stripGit(rawName)
    return validName(name) ? githubRef(owner, name) : null
  }
  let parsed: URL
  try {
    parsed = new URL(input)
  } catch {
    return null
  }
  if (parsed.protocol !== "https:") return null
  if (parsed.username !== "" || parsed.password !== "" || parsed.port !== "" || parsed.search !== "" || parsed.hash !== "") return null
  const segments = parsed.pathname.split("/").filter((s) => s !== "")
  if (segments.length < 2) return null
  const last = stripGit(segments[segments.length - 1] as string)
  const parts = [...segments.slice(0, -1), last]
  if (!parts.every((p) => SEGMENT.test(p) && validName(p))) return null
  if (parsed.hostname === GITHUB_HOST) {
    if (parts.length !== 2) return null
    const slug = parts.join("/")
    return Schema.is(GithubRepoSlug)(slug) ? githubRef(parts[0] as string, parts[1] as string) : null
  }
  const url = `https://${parsed.hostname}/${parts.join("/")}.git`
  return {
    repo: url,
    url,
    mirrorRel: `${parsed.hostname}/${parts.join("/")}.git`,
    name: last,
    github: null,
  }
}
