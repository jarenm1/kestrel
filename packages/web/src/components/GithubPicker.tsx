import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import type { GithubRepo } from "@cloudagents/protocol"
import { api } from "../api/client"
import { errorText } from "../util"

type PickerState =
  | { status: "loading" }
  | { status: "not-connected" }
  | { status: "error"; message: string }
  | { status: "ready"; repos: readonly GithubRepo[] }

export function GithubPicker({ disabled, onPick }: { disabled: boolean; onPick: (repo: GithubRepo) => void }) {
  const [state, setState] = useState<PickerState>({ status: "loading" })
  const [filter, setFilter] = useState("")

  useEffect(() => {
    let active = true
    api
      .connections()
      .then(async (connections): Promise<PickerState> => {
        const github = connections.find((c) => c.provider === "github")
        if (!github?.connected) return { status: "not-connected" }
        return { status: "ready", repos: await api.githubRepos() }
      })
      .then(
        (next) => {
          if (active) setState(next)
        },
        (e: unknown) => {
          if (active) setState({ status: "error", message: errorText(e) })
        },
      )
    return () => {
      active = false
    }
  }, [])

  if (state.status === "loading") return <div className="muted">Loading GitHub repositories…</div>
  if (state.status === "not-connected") {
    return (
      <div className="muted">
        GitHub is not connected. <Link to="/connections">Connect GitHub</Link> to pick repositories from your account.
      </div>
    )
  }
  if (state.status === "error") return <div className="error">{state.message}</div>

  const needle = filter.trim().toLowerCase()
  const matches = state.repos.filter((repo) => repo.fullName.toLowerCase().includes(needle))

  return (
    <div className="picker">
      <input
        type="search"
        placeholder={`Filter ${state.repos.length} GitHub repositories`}
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      {matches.length === 0 && <div className="muted">No matching repositories.</div>}
      <ul className="list picker-list">
        {matches.map((repo) => (
          <li key={repo.cloneUrl}>
            <span className="picker-name">{repo.fullName}</span>
            {repo.private && <span className="badge">private</span>}
            <span className="muted">{repo.defaultBranch}</span>
            <button type="button" className="small" disabled={disabled} onClick={() => onPick(repo)}>
              Add
            </button>
          </li>
        ))}
      </ul>
      <div className="muted">Showing your 100 most recently updated repositories.</div>
    </div>
  )
}
