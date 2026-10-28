import { useEffect, useState } from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { NavLink, Route, Routes } from "react-router-dom"
import { LogOut } from "lucide-react"
import { api, ApiError, onUnauthorized } from "@/api/client"
import { queries } from "@/api/queries"
import { KestrelMark } from "@/components/KestrelMark"
import { Alert } from "@/components/ui/alert"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import { ConnectionsPage } from "@/pages/ConnectionsPage"
import { LoginPage } from "@/pages/LoginPage"
import { RepoPage } from "@/pages/RepoPage"
import { ReposPage } from "@/pages/ReposPage"
import { errorText } from "@/util"

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    "rounded-full px-2.5 py-1 text-muted-foreground transition-colors duration-200 hover:text-foreground",
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
      <header className="flex h-11 shrink-0 items-center gap-4 px-4">
        <NavLink
          to="/"
          aria-label="Kestrel home"
          className="rounded-full text-foreground/90 transition-colors duration-200 hover:text-foreground"
        >
          <KestrelMark className="h-5" />
        </NavLink>
        <nav className="flex gap-1">
          <NavLink to="/" end className={navLinkClass}>
            Repos
          </NavLink>
          <NavLink to="/connections" className={navLinkClass}>
            Connections
          </NavLink>
        </nav>
        <div className="ml-auto">
          <AccountMenu login={me.data.login} avatarUrl={me.data.avatarUrl} />
        </div>
      </header>
      <main className="flex min-h-0 flex-1 flex-col">
        <Routes>
          <Route path="/" element={<ReposPage />} />
          <Route path="/connections" element={<ConnectionsPage />} />
          <Route path="/repos/:repoId" element={<RepoPage />} />
          <Route path="/repos/:repoId/threads/:taskId" element={<RepoPage />} />
          <Route path="/repos/:repoId/automations" element={<RepoPage view="automations" />} />
          <Route path="/repos/:repoId/archived" element={<RepoPage view="archived" />} />
          <Route path="*" element={<div className="p-5 text-muted-foreground">Not found.</div>} />
        </Routes>
      </main>
    </div>
  )
}

function AccountMenu({ login, avatarUrl }: { login: string; avatarUrl: string }) {
  const signOut = useMutation({
    mutationFn: api.logout,
    // Reload re-checks the session either way.
    onSettled: () => window.location.reload(),
  })

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Account"
        className="grid size-7 place-items-center overflow-hidden rounded-full bg-white/[0.08] text-xs font-medium uppercase shadow-soft transition-shadow duration-200 outline-none hover:shadow-glow focus-visible:shadow-glow data-[state=open]:shadow-glow"
      >
        {avatarUrl ? <img className="size-full" src={avatarUrl} alt="" /> : login.slice(0, 1)}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>
          Signed in as <span className="text-foreground">{login}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={signOut.isPending} onSelect={() => signOut.mutate()}>
          <LogOut />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
