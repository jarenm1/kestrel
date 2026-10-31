import { useEffect, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { ControlPaths } from "@cloudagents/protocol"
import { Navigate, Outlet, Route, Routes, useLocation, useParams } from "react-router-dom"
import { ApiError, onUnauthorized } from "@/api/client"
import { queries } from "@/api/queries"
import { ArchivedPanel } from "@/components/ArchivedPanel"
import { AutomationsPanel } from "@/components/AutomationsPanel"
import { PublicShell } from "@/components/PublicShell"
import { Alert } from "@/components/ui/alert"
import { LandingPage } from "@/pages/LandingPage"
import { LoginPage } from "@/pages/LoginPage"
import { NewThreadPage } from "@/pages/NewThreadPage"
import { PairPage } from "@/pages/PairPage"
import { PricingPage } from "@/pages/PricingPage"
import { BillingSettings, BoxesSettings, ConnectionsSettings, ProfileSettings, SettingsLayout } from "@/pages/SettingsPage"
import { ThreadPage } from "@/pages/ThreadPage"
import { WorkspaceLayout } from "@/pages/WorkspaceLayout"
import { APP_HOME, APP_ORIGIN, IS_SITE_HOST, threadPath } from "@/routes"
import { errorText } from "@/util"

export function App() {
  if (IS_SITE_HOST) {
    return (
      <Routes>
        {/* The public site never mounts the session query; everything else belongs to the app host. */}
        <Route element={<PublicShell />}>
          <Route path="/" element={<LandingPage />} />
          <Route path="/pricing" element={<PricingPage />} />
        </Route>
        <Route path="*" element={<AppHostRedirect />} />
      </Routes>
    )
  }

  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />

      {/* Protected routes. The guard is the only place that checks the session. */}
      <Route element={<RequireAuth />}>
        <Route element={<WorkspaceLayout />}>
          <Route path={APP_HOME} element={<NewThreadPage />} />
          <Route path="/c/:taskId" element={<ThreadPage />} />
          <Route path="/automations" element={<AutomationsPanel />} />
          <Route path="/archived" element={<ArchivedPanel />} />
          <Route path={ControlPaths.pairPage} element={<PairPage />} />
          <Route path="/settings" element={<SettingsLayout />}>
            <Route index element={<Navigate to="profile" replace />} />
            <Route path="profile" element={<ProfileSettings />} />
            <Route path="connections" element={<ConnectionsSettings />} />
            <Route path="boxes" element={<BoxesSettings />} />
            <Route path="billing" element={<BillingSettings />} />
          </Route>
        </Route>
        {/* Legacy thread URLs (including the old per-repo ones) resolve to the canonical thread URL. */}
        <Route path="/tasks/:taskId" element={<ThreadRedirect />} />
        <Route path="/repos/:repoId/threads/:taskId" element={<ThreadRedirect />} />
        <Route path="/repos/*" element={<Navigate to={APP_HOME} replace />} />
      </Route>

      <Route path="*" element={<NotFound />} />
    </Routes>
  )
}

/** A non-public path on the public site (e.g. an old app link): continue on the app host with the same path. */
function AppHostRedirect() {
  const { pathname, search } = useLocation()
  useEffect(() => window.location.replace(`${APP_ORIGIN}${pathname}${search}`), [pathname, search])
  return null
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
