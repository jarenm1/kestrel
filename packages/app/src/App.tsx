import { useEffect, useState } from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { Navigate, NavLink, Outlet, Route, Routes, useLocation, useParams } from "react-router-dom"
import { LogOut } from "lucide-react"
import { api, ApiError, onUnauthorized } from "@/api/client"
import { queries } from "@/api/queries"
import { ArchivedPanel } from "@/components/ArchivedPanel"
import { AutomationsPanel } from "@/components/AutomationsPanel"
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
import { LandingPage } from "@/pages/LandingPage"
import { LoginPage } from "@/pages/LoginPage"
import { NewThreadPage } from "@/pages/NewThreadPage"
import { PricingPage } from "@/pages/PricingPage"
import { ThreadPage } from "@/pages/ThreadPage"
import { WorkspaceLayout } from "@/pages/WorkspaceLayout"
import { APP_HOME, threadPath } from "@/routes"
import { errorText } from "@/util"

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    "rounded-full px-2.5 py-1 text-muted-foreground transition-colors duration-200 hover:text-foreground",
    isActive && "bg-white/[0.07] text-foreground",
  )

export function App() {
  return (
    <Routes>
      {/* Public routes. They never mount the session query, so they render immediately. */}
      <Route path="/" element={<LandingPage />} />
      <Route path="/pricing" element={<PricingPage />} />
      <Route path="/login" element={<LoginPage />} />

      {/* Protected routes. The guard is the only place that checks the session. */}
      <Route element={<RequireAuth />}>
        <Route element={<AppShell />}>
          <Route path="/connections" element={<ConnectionsPage />} />
          <Route element={<WorkspaceLayout />}>
            <Route path={APP_HOME} element={<NewThreadPage />} />
            <Route path={`${APP_HOME}/:taskId`} element={<ThreadPage />} />
            <Route path="/automations" element={<AutomationsPanel />} />
            <Route path="/archived" element={<ArchivedPanel />} />
          </Route>
          {/* Legacy thread URLs (including the old per-repo ones) resolve to the canonical thread URL. */}
          <Route path="/tasks/:taskId" element={<ThreadRedirect />} />
          <Route path="/repos/:repoId/threads/:taskId" element={<ThreadRedirect />} />
          <Route path="/repos/*" element={<Navigate to={APP_HOME} replace />} />
        </Route>
      </Route>

      <Route path="*" element={<NotFound />} />
    </Routes>
  )
}

/**
 * Session gate. It runs `queries.me()` only for protected routes, then either redirects to the
 * login page (preserving the attempted path) or renders the protected layout.
 */
function RequireAuth() {
  const me = useQuery(queries.me())
  const [expired, setExpired] = useState(false)
  const location = useLocation()

  useEffect(() => onUnauthorized(() => setExpired(true)), [])

  const signedOut = expired || (me.error instanceof ApiError && me.error.status === 401)

  if (signedOut) {
    const next = location.pathname + location.search
    return <Navigate to={`/login?return=${encodeURIComponent(next)}`} replace />
  }
  if (me.isPending) return <FullPageMessage>Loading…</FullPageMessage>
  if (me.isError) {
    return (
      <FullPageMessage>
        <Alert className="max-w-md">{errorText(me.error)}</Alert>
      </FullPageMessage>
    )
  }

  return <Outlet />
}

/** Header and account menu shared by every protected page. */
function AppShell() {
  const me = useQuery(queries.me())

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-11 shrink-0 items-center gap-4 px-4">
        <NavLink
          to={APP_HOME}
          aria-label="Kestrel home"
          className="rounded-full text-foreground/90 transition-colors duration-200 hover:text-foreground"
        >
          <KestrelMark className="h-5" />
        </NavLink>
        <nav className="flex gap-1">

          <NavLink to="/connections" className={navLinkClass}>
            Connections
          </NavLink>
        </nav>
        <div className="ml-auto">
          {me.data ? <AccountMenu login={me.data.login} avatarUrl={me.data.avatarUrl} /> : null}
        </div>
      </header>
      <main className="flex min-h-0 flex-1 flex-col">
        <Outlet />
      </main>
    </div>
  )
}

/** Sends short and legacy thread links to the one canonical address per thread. */
function ThreadRedirect() {
  const { taskId = "" } = useParams()
  return <Navigate to={threadPath(taskId)} replace />
}

function FullPageMessage({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full items-center justify-center p-5 text-muted-foreground">{children}</div>
}

function NotFound() {
  return <FullPageMessage>Not found.</FullPageMessage>
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
