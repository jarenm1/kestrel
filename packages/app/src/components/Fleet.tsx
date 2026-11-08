import { useQuery } from "@tanstack/react-query"
import { type NestHostStatus } from "@cloudagents/protocol"
import { queries } from "@/api/queries"
import { Alert } from "@cloudagents/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { errorText, formatSize, formatTime } from "@/util"

/** Settings › Fleet (operators only): the Nest hosts Kestrel's boxes run on, and the failures they report. */
export function Fleet() {
  return (
    <>
      <NestHosts />
      <ToolFailures />
    </>
  )
}

/** Nest hosts and what each one has free. */
function NestHosts() {
  const hosts = useQuery({ ...queries.nestHosts(), refetchInterval: 5_000 })

  return (
    <>
      {hosts.error && <Alert>{errorText(hosts.error)}</Alert>}
      {hosts.isPending && <div className="text-muted-foreground">Loading…</div>}
      {hosts.data && (
        <Card className="py-0">
          <CardContent className="divide-y divide-white/[0.04] px-0">
            {hosts.data.hosts.length === 0 && <div className="px-5 py-4 text-muted-foreground">No Nest hosts yet.</div>}
            {hosts.data.hosts.map((host) => (
              <NestHostRow key={host.id} host={host} />
            ))}
          </CardContent>
        </Card>
      )}
    </>
  )
}

function NestHostRow({ host }: { host: NestHostStatus }) {
  const cap = host.capacity
  return (
    <div className="flex flex-col gap-2.5 px-5 py-4">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="truncate font-medium">{host.name}</span>
        <Badge variant={host.connected ? "success" : "neutral"}>{host.connected ? "connected" : "offline"}</Badge>
        {host.agentVersion && <span className="text-xs text-muted-foreground">agent {host.agentVersion}</span>}
        {host.lastSeenAt && !host.connected && (
          <span className="text-xs text-muted-foreground">last seen {formatTime(host.lastSeenAt)}</span>
        )}
      </div>
      {cap ? (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>
            {cap.running} running, {cap.suspended} suspended
          </span>
          <span>
            vCPUs {cap.vcpusPlugged} of {cap.vcpus} plugged
          </span>
          <span>
            Memory {formatSize(cap.memoryPluggedBytes)} of {formatSize(cap.memoryBytes)} plugged
          </span>
          <span>
            Disk {formatSize(cap.diskFreeBytes)} free, {formatSize(cap.diskReservedBytes)} reserved
          </span>
          <span>
            GPUs {cap.gpus.filter((gpu) => gpu.attachedTo === null).length} of {cap.gpus.length} free
          </span>
        </div>
      ) : (
        <span className="text-xs text-muted-foreground">No capacity reported yet.</span>
      )}
    </div>
  )
}

/** What failed across Kestrel's boxes, most common first (the server's order). */
function ToolFailures() {
  const list = useQuery(queries.fleetToolFailures())

  return (
    <Card className="py-0">
      <CardContent className="flex flex-col gap-3 px-5 py-4">
        <div>
          <span className="font-medium">Common failures</span>
          <p className="text-muted-foreground">
            Failed tools and agent turns{list.data && ` of the last ${list.data.days} days`}, most common first.
          </p>
        </div>
        {list.error && <Alert>{errorText(list.error)}</Alert>}
        {list.isPending && <div className="text-muted-foreground">Loading…</div>}
        {list.data?.failures.length === 0 && <div className="text-muted-foreground">No failures reported.</div>}
        {list.data && list.data.failures.length > 0 && (
          <ol className="divide-y divide-white/[0.04]">
            {list.data.failures.map((failure) => (
              <li key={`${failure.tool}\n${failure.signature}`} className="flex items-start gap-4 py-2.5">
                <span className="w-12 shrink-0 text-right font-medium tabular-nums">{failure.count}</span>
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="truncate font-mono text-xs">{failure.tool}</span>
                  <span className="break-words text-muted-foreground">{failure.signature}</span>
                </div>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {failure.firstSeen === failure.lastSeen ? failure.lastSeen : `${failure.firstSeen} to ${failure.lastSeen}`}
                </span>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  )
}
