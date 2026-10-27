import { useEffect, useState } from "react"
import { NavLink, Route, Routes } from "react-router-dom"
import type { Me } from "@cloudagents/protocol"
import { api, ApiError, onUnauthorized } from "./api/client"
import { BoxPill, BoxProvider } from "./components/BoxStatus"
import { ConnectionsPage } from "./pages/ConnectionsPage"
import { LoginPage } from "./pages/LoginPage"
import { RepoPage } from "./pages/RepoPage"
import { ReposPage } from "./pages/ReposPage"
import { TaskPage } from "./pages/TaskPage"
import { errorText } from "./util"

type AuthState =
  | { status: "loading" }
  | { status: "signed-out" }
  | { status: "signed-in"; me: Me }
  | { status: "error"; message: string }

export function App() {
  const [auth, setAuth] = useState<AuthState>({ status: "loading" })

  useEffect(() => onUnauthorized(() => setAuth({ status: "signed-out" })), [])

  useEffect(() => {
    let active = true
    api.me().then(
      (me) => {
        if (active) setAuth({ status: "signed-in", me })
      },
      (e: unknown) => {
        if (!active) return
        const signedOut = e instanceof ApiError && e.status === 401
        setAuth(signedOut ? { status: "signed-out" } : { status: "error", message: errorText(e) })
      },
    )
    return () => {
      active = false
    }
  }, [])

  if (auth.status === "loading") return <div className="page muted">Loading…</div>
  if (auth.status === "error") return <div className="page error">{auth.message}</div>
  if (auth.status === "signed-out") return <LoginPage />

  return (
    <BoxProvider>
      <div className="app">
        <header className="topbar">
          <NavLink to="/" className="brand">
            Kestrel
          </NavLink>
          <nav className="nav">
            <NavLink to="/" end className={({ isActive }) => (isActive ? "nav-link active" : "nav-link")}>
              Repos
            </NavLink>
            <NavLink
              to="/connections"
              className={({ isActive }) => (isActive ? "nav-link active" : "nav-link")}
            >
              Connections
            </NavLink>
          </nav>
          <div className="topbar-end">
            <BoxPill />
            <img className="avatar" src={auth.me.avatarUrl} alt="" width={20} height={20} />
            <span className="muted">{auth.me.login}</span>
            <SignOutButton />
          </div>
        </header>
        <main className="main">
          <Routes>
            <Route path="/" element={<ReposPage />} />
            <Route path="/connections" element={<ConnectionsPage />} />
            <Route path="/repos/:repoId" element={<RepoPage />} />
            <Route path="/tasks/:taskId" element={<TaskPage />} />
            <Route path="*" element={<div className="page muted">Not found.</div>} />
          </Routes>
        </main>
      </div>
    </BoxProvider>
  )
}

function SignOutButton() {
  const [busy, setBusy] = useState(false)

  async function signOut() {
    setBusy(true)
    try {
      await api.logout()
    } catch {
      // Reload re-checks the session either way.
    }
    window.location.reload()
  }

  return (
    <button type="button" className="small" disabled={busy} onClick={() => void signOut()}>
      Sign out
    </button>
  )
}
