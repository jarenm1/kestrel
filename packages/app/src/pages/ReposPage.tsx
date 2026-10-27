import { useEffect, useState, type FormEvent } from "react"
import { Link, useNavigate } from "react-router-dom"
import type { CreateRepoBody, Repo } from "@cloudagents/protocol"
import { api } from "../api/client"
import { BoxOfflineBanner, useBoxOffline } from "../components/BoxStatus"
import { GithubPicker } from "../components/GithubPicker"
import { errorText } from "../util"

export function ReposPage() {
  const navigate = useNavigate()
  const offline = useBoxOffline()
  const [repos, setRepos] = useState<readonly Repo[] | null>(null)
  const [url, setUrl] = useState("")
  const [name, setName] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    api.listRepos().then(
      (list) => {
        if (active) setRepos(list)
      },
      (e: unknown) => {
        if (active) setError(errorText(e))
      },
    )
    return () => {
      active = false
    }
  }, [])

  async function addRepo(body: CreateRepoBody) {
    setBusy(true)
    setError(null)
    try {
      const repo = await api.addRepo(body)
      navigate(`/repos/${repo.id}`)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="page">
      <h1>Repositories</h1>
      <BoxOfflineBanner />
      <section className="section">
        <h2>Add from GitHub</h2>
        <GithubPicker
          disabled={busy || offline}
          onPick={(repo) => void addRepo({ url: repo.cloneUrl, name: repo.fullName })}
        />
      </section>
      <section className="section">
        <h2>Add by URL</h2>
        <form
          className="row-form"
          onSubmit={(e: FormEvent<HTMLFormElement>) => {
            e.preventDefault()
            void addRepo({ url: url.trim(), name: name.trim() || undefined })
          }}
        >
          <input
            type="url"
            required
            placeholder="Git clone URL"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <input placeholder="Name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
          <button type="submit" disabled={busy || offline || url.trim() === ""}>
            {busy ? "Cloning…" : "Add repo"}
          </button>
        </form>
      </section>
      {error && <div className="error">{error}</div>}
      {repos === null && !error && <div className="muted">Loading…</div>}
      {repos?.length === 0 && <div className="muted">No repositories yet.</div>}
      <ul className="list">
        {repos?.map((repo) => (
          <li key={repo.id}>
            <Link to={`/repos/${repo.id}`}>{repo.name}</Link>
            <span className="muted mono">{repo.url}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
