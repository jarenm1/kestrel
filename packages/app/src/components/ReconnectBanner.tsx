import { useQuery } from "@tanstack/react-query"
import { ControlPaths } from "@cloudagents/protocol"
import { useLocation } from "react-router-dom"
import { queries } from "@/api/queries"
import { Alert } from "@cloudagents/ui/alert"
import { SERVER_URL } from "@/config"

/** Shown while a provider refuses a stored OAuth token: agents cannot use that connection until the user reconnects. */
export function ReconnectBanner({ className }: { className?: string }) {
  const { pathname, search, hash } = useLocation()
  const returnTo = encodeURIComponent(pathname + search + hash)
  const connections = useQuery(queries.connections())
  const expired = connections.data?.filter((c) => c.expired === true) ?? []
  return expired.map((connection) => {
    return (
      <Alert key={connection.provider} variant="warning" className={className}>
        {connection.label} no longer accepts Kestrel's access, so agents cannot fetch or push repositories.{" "}
        <a
          className="font-medium text-foreground underline"
          href={SERVER_URL + ControlPaths.connectOAuth(connection.provider) + `?return=${returnTo}`}
        >
          Reconnect {connection.label}
        </a>
      </Alert>
    )
  })
}
