import { Schema } from "effect"
import { GithubRepoSlug, type Checkout } from "@cloudagents/protocol"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

const isGithubRepo = Schema.is(GithubRepoSlug)

/**
 * Opens the thread's GitHub repository: a link with one repository, a menu of them with several. Renders nothing
 * when no checkout is a GitHub repository (other https clones have no GitHub page).
 */
export function ThreadRepoButton({ checkouts }: { checkouts: readonly Checkout[] }) {
  const repos = checkouts.flatMap((checkout) => (isGithubRepo(checkout.repo) ? [checkout.repo] : []))
  const [only] = repos
  if (only === undefined) return null
  if (repos.length === 1) {
    return (
      <Button asChild variant="ghost" size="icon" title={only}>
        <a href={githubUrl(only)} target="_blank" rel="noreferrer" aria-label={`Open ${only} on GitHub`}>
          <GitHubMark />
        </a>
      </Button>
    )
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Open a repository on GitHub"
          title="Repositories"
          className="data-[state=open]:bg-white/[0.06]"
        >
          <GitHubMark />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="left" align="end">
        <DropdownMenuLabel>Open on GitHub</DropdownMenuLabel>
        {repos.map((repo) => (
          <DropdownMenuItem key={repo} asChild>
            <a href={githubUrl(repo)} target="_blank" rel="noreferrer">
              <GitHubMark />
              {repo}
            </a>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

const githubUrl = (repo: GithubRepoSlug) => `https://github.com/${repo}`

/** GitHub's mark (Octicons `mark-github`); lucide has no brand icons. */
function GitHubMark() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z" />
    </svg>
  )
}
