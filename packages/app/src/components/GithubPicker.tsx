import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Link } from "react-router-dom"
import type { GithubRepo } from "@cloudagents/protocol"
import { queries } from "@/api/queries"
import { Alert } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { errorText } from "@/util"

export function GithubPicker({ disabled, onPick }: { disabled: boolean; onPick: (repo: GithubRepo) => void }) {
  const connections = useQuery(queries.connections())
  const connected = connections.data?.some((c) => c.provider === "github" && c.connected) ?? false
  const repos = useQuery({ ...queries.githubRepos(), enabled: connected })
  const [filter, setFilter] = useState("")

  const error = connections.error ?? repos.error
  if (error) return <Alert>{errorText(error)}</Alert>
  if (connections.isPending) return <div className="text-muted-foreground">Loading GitHub repositories…</div>
  if (!connected) {
    return (
      <div className="text-muted-foreground">
        GitHub is not connected.{" "}
        <Link to="/connections" className="text-primary hover:underline">
          Connect GitHub
        </Link>{" "}
        to pick repositories from your account.
      </div>
    )
  }
  if (!repos.data) return <div className="text-muted-foreground">Loading GitHub repositories…</div>

  const needle = filter.trim().toLowerCase()
  const matches = repos.data.filter((repo) => repo.fullName.toLowerCase().includes(needle))

  return (
    <div className="flex flex-col gap-2">
      <Input
        className="max-w-sm"
        type="search"
        placeholder={`Filter ${repos.data.length} GitHub repositories`}
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      {matches.length === 0 && <div className="text-muted-foreground">No matching repositories.</div>}
      <ul className="max-h-80 overflow-auto rounded-xl bg-code/60 p-1.5 shadow-well">
        {matches.map((repo) => (
          <li
            key={repo.cloneUrl}
            className="flex items-center gap-3 rounded-lg px-2.5 py-1.5 transition-colors duration-200 hover:bg-white/[0.04]"
          >
            <span className="min-w-0 flex-1 truncate">{repo.fullName}</span>
            {repo.private && <Badge>private</Badge>}
            <span className="text-muted-foreground">{repo.defaultBranch}</span>
            <Button variant="soft" size="sm" disabled={disabled} onClick={() => onPick(repo)}>
              Add
            </Button>
          </li>
        ))}
      </ul>
    </div>
  )
}
