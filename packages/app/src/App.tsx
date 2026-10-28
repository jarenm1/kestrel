import { useEffect, useState } from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { NavLink, Route, Routes } from "react-router-dom"
import { api, ApiError, onUnauthorized } from "@/api/client"
import { queries } from "@/api/queries"
import { KestrelMark } from "@/components/KestrelMark"
import { Alert } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { ConnectionsPage } from "@/pages/ConnectionsPage"
import { LoginPage } from "@/pages/LoginPage"
import { RepoPage } from "@/pages/RepoPage"
import { ReposPage } from "@/pages/ReposPage"
import { TaskPage } from "@/pages/TaskPage"
import { errorText } from "@/util"

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    "rounded-full px-3 py-1.5 text-muted-foreground transition-colors duration-200 hover:text-foreground",
    isActive && "bg-white/[0.07] text-foreground",
  )

export function App() {
  const me = useQuery(queries.me())
  const [expired, setExpired] = useState(false)

  useEffect(() => onUnauthorized(() => setExpired(true)), [])

  const signedOut = expired || (me.error instanceof ApiError && me.error.status === 401)
  if (signedOut) return <LoginPage />
  if (me.isPending) return <div className="p-5 text-muted-foreground">Loading…</div>
  if (me.isError) {
    return (
      <div className="p-5">
        <Alert>{errorText(me.error)}</Alert>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-14 shrink-0 items-center gap-5 px-5">
        <NavLink
          to="/"
          aria-label="Kestrel home"
          className="rounded-full text-foreground/90 transition-colors duration-200 hover:text-foreground"
        >
          <KestrelMark className="h-6" />
        </NavLink>
        <nav className="flex gap-1">
          <NavLink to="/" end className={navLinkClass}>
            Repos
          </NavLink>
          <NavLink to="/connections" className={navLinkClass}>
            Connections
          </NavLink>
        </nav>
        <div className="ml-auto flex items-center gap-3">
          <img
            className="rounded-full shadow-soft"
            src={me.data.avatarUrl}
            alt={me.data.login}
            title={me.data.login}
            width={24}
            height={24}
          />
          <SignOutButton />
        </div>
      </header>
      <main className="flex min-h-0 flex-1 flex-col">
        <Routes>
          <Route path="/" element={<ReposPage />} />
          <Route path="/connections" element={<ConnectionsPage />} />
          <Route path="/repos/:repoId" element={<RepoPage />} />
          <Route path="/tasks/:taskId" element={<TaskPage />} />
          <Route path="*" element={<div className="p-5 text-muted-foreground">Not found.</div>} />
        </Routes>
      </main>
    </div>
  )
}

function SignOutButton() {
  const signOut = useMutation({
    mutationFn: api.logout,
    // Reload re-checks the session either way.
    onSettled: () => window.location.reload(),
  })

  return (
    <Button variant="ghost" size="sm" disabled={signOut.isPending} onClick={() => signOut.mutate()}>
      Sign out
    </Button>
  )
}
