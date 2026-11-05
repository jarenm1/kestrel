import { useQuery } from "@tanstack/react-query"
import { ControlPaths } from "@cloudagents/protocol"
import { queries } from "@/api/queries"
import { Alert } from "@cloudagents/ui/alert"
import { SERVER_URL } from "@/config"

/** Where each OAuth connection is managed in Settings; the OAuth callback returns there, not to Connections. */
const RETURN_PATHS: Record<string, string> = { github: "/settings/profile" }

/** Shown while a provider refuses a stored OAuth token: agents cannot use that connection until the user reconnects. */
export function ReconnectBanner({ className }: { className?: string }) {
  const connections = useQuery(queries.connections())
  const expired = connections.data?.filter((c) => c.expired === true) ?? []
  return expired.map((connection) => {
    const returnTo = RETURN_PATHS[connection.provider]
    return (
      <Alert key={connection.provider} variant="warning" className={className}>
        {connection.label} no longer accepts Kestrel's access, so agents cannot fetch or push repositories.{" "}
        <a
          className="font-medium text-foreground underline"
          href={SERVER_URL + ControlPaths.connectOAuth(connection.provider) + (returnTo ? `?return=${returnTo}` : "")}
        >
          Reconnect {connection.label}
        </a>
      </Alert>
    )
  })
}
