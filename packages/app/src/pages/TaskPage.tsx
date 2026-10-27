import { useState } from "react"
import { useParams } from "react-router-dom"
import { BoxOfflineBanner } from "../components/BoxStatus"
import { ChatPanel } from "../components/ChatPanel"
import { DesktopViewer } from "../components/DesktopViewer"
import { DiffPanel } from "../components/DiffPanel"
import { StatusBadge } from "../components/StatusBadge"
import { useTaskState } from "../hooks/useTaskState"

type Tab = "desktop" | "diff"

export function TaskPage() {
  const { taskId = "" } = useParams()
  // Keyed so switching tasks discards all per-task state.
  return <TaskView key={taskId} taskId={taskId} />
}

function TaskView({ taskId }: { taskId: string }) {
  const state = useTaskState(taskId)
  const [tab, setTab] = useState<Tab>("desktop")
  const { task } = state

  return (
    <>
      <BoxOfflineBanner />
      <div className="split">
        <section className="pane">
          <header className="pane-header">
            <strong>{task?.title ?? "Loading…"}</strong>
            {task && <StatusBadge status={task.status} />}
            {task && <span className="muted mono">{task.branch}</span>}
          </header>
          {state.error && <div className="error">{state.error}</div>}
          <ChatPanel
            taskId={taskId}
            messages={state.messages}
            runs={state.runs}
            output={state.output}
            onMessage={state.upsertMessage}
            onRun={state.upsertRun}
          />
        </section>
        <section className="pane">
          <nav className="tabs">
            <button className={tab === "desktop" ? "tab active" : "tab"} onClick={() => setTab("desktop")}>
              Desktop
            </button>
            <button className={tab === "diff" ? "tab active" : "tab"} onClick={() => setTab("diff")}>
              Diff
            </button>
          </nav>
          <div className="tab-body" hidden={tab !== "desktop"}>
            <DesktopViewer taskId={taskId} />
          </div>
          <div className="tab-body" hidden={tab !== "diff"}>
            <DiffPanel taskId={taskId} />
          </div>
        </section>
      </div>
    </>
  )
}
