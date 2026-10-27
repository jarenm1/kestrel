import { useCallback, useEffect, useState } from "react"
import { api } from "../api/client"
import { errorText } from "../util"

function diffLineClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) return "diff-file"
  if (line.startsWith("+")) return "diff-add"
  if (line.startsWith("-")) return "diff-del"
  if (line.startsWith("@@")) return "diff-hunk"
  return ""
}

export function DiffPanel({ taskId }: { taskId: string }) {
  const [baseBranch, setBaseBranch] = useState<string | null>(null)
  const [diff, setDiff] = useState<string>("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await api.getDiff(taskId)
      setBaseBranch(res.baseBranch)
      setDiff(res.diff)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setLoading(false)
    }
  }, [taskId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const lines = diff.split("\n")

  return (
    <div className="diff">
      <div className="toolbar">
        <span className="muted">{baseBranch ? `vs ${baseBranch}` : "diff"}</span>
        <button onClick={() => void refresh()} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      {error && <div className="error">{error}</div>}
      <pre className="diff-body mono">
        {diff.trim() === "" && !loading && !error ? (
          <span className="muted">No changes.</span>
        ) : (
          lines.map((line, i) => (
            <div key={i} className={diffLineClass(line)}>
              {line || " "}
            </div>
          ))
        )}
      </pre>
    </div>
  )
}
