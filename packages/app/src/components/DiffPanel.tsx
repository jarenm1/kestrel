import { useQuery } from "@tanstack/react-query"
import { queries } from "@/api/queries"
import { Alert } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { errorText } from "@/util"

function diffLineClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) return "font-semibold text-foreground"
  if (line.startsWith("+")) return "bg-success/10 text-success"
  if (line.startsWith("-")) return "bg-destructive/10 text-destructive"
  if (line.startsWith("@@")) return "text-info"
  return ""
}

export function DiffPanel({ taskId }: { taskId: string }) {
  const diff = useQuery(queries.diff(taskId))
  const text = diff.data?.diff ?? ""

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 px-4 pb-2">
        <span className="text-muted-foreground">{diff.data ? `vs ${diff.data.baseBranch}` : "diff"}</span>
        <Button variant="soft" size="sm" onClick={() => void diff.refetch()} disabled={diff.isFetching}>
          {diff.isFetching ? "Refreshing…" : "Refresh"}
        </Button>
      </div>
      {diff.error && <Alert className="mx-3 mb-2 w-auto">{errorText(diff.error)}</Alert>}
      <pre className="mx-3 mb-3 min-h-0 flex-1 overflow-auto rounded-xl bg-code py-2.5 font-mono text-xs shadow-well">
        {diff.isSuccess && text.trim() === "" ? (
          <span className="px-3 text-muted-foreground">No changes.</span>
        ) : (
          text.split("\n").map((line, i) => (
            <div key={i} className={`px-3 whitespace-pre ${diffLineClass(line)}`}>
              {line || " "}
            </div>
          ))
        )}
      </pre>
    </div>
  )
}
