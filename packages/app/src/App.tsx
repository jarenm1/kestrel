import { useEffect, useState } from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { NavLink, Route, Routes } from "react-router-dom"
import { api, ApiError, onUnauthorized } from "@/api/client"
import { queries } from "@/api/queries"
import { BoxPill } from "@/components/BoxStatus"
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
    "rounded-md px-2.5 py-1 text-muted-foreground transition-colors hover:text-foreground",
    isActive && "bg-secondary text-foreground",
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
      <header className="flex h-11 shrink-0 items-center gap-4 border-b bg-card px-4">
        <NavLink to="/" className="font-semibold tracking-tight">
          Kestrel
        </NavLink>
        <nav className="flex gap-1">
          <NavLink to="/" end className={navLinkClass}>
            Repos
          </NavLink>
          <NavLink to="/connections" className={navLinkClass}>
            Connections
          </NavLink>
        </nav>
        <div className="ml-auto flex items-center gap-2.5">
          <BoxPill />
          <img className="rounded-full" src={me.data.avatarUrl} alt="" width={20} height={20} />
          <span className="text-muted-foreground">{me.data.login}</span>
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
    <Button variant="outline" size="sm" disabled={signOut.isPending} onClick={() => signOut.mutate()}>
      Sign out
    </Button>
  )
}
