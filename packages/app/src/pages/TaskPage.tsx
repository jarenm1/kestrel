import { useParams } from "react-router-dom"
import { BoxOfflineBanner } from "@/components/BoxStatus"
import { ChatPanel } from "@/components/ChatPanel"
import { DesktopViewer } from "@/components/DesktopViewer"
import { DiffPanel } from "@/components/DiffPanel"
import { StatusBadge } from "@/components/StatusBadge"
import { Alert } from "@/components/ui/alert"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useTaskState } from "@/hooks/useTaskState"

export function TaskPage() {
  const { taskId = "" } = useParams()
  // Keyed so switching tasks discards all per-task state.
  return <TaskView key={taskId} taskId={taskId} />
}

function TaskView({ taskId }: { taskId: string }) {
  const state = useTaskState(taskId)
  const { task } = state

  return (
    <>
      <BoxOfflineBanner />
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(320px,1fr)_minmax(320px,1fr)]">
        <section className="flex min-h-0 min-w-0 flex-col border-r">
          <header className="flex min-w-0 items-center gap-2 border-b bg-card px-4 py-2.5">
            <strong className="truncate">{task?.title ?? "Loading…"}</strong>
            {task && <StatusBadge status={task.status} />}
            {task && <span className="truncate font-mono text-xs text-muted-foreground">{task.branch}</span>}
          </header>
          {state.error && <Alert className="rounded-none border-x-0 border-t-0">{state.error}</Alert>}
          <ChatPanel taskId={taskId} messages={state.messages} runs={state.runs} output={state.output} />
        </section>
        <Tabs defaultValue="desktop" className="min-h-0 min-w-0">
          <div className="border-b bg-card px-3 py-1.5">
            <TabsList>
              <TabsTrigger value="desktop">Desktop</TabsTrigger>
              <TabsTrigger value="diff">Diff</TabsTrigger>
            </TabsList>
          </div>
          <TabsContent value="desktop" className="flex min-h-0 flex-col">
            <DesktopViewer taskId={taskId} />
          </TabsContent>
          <TabsContent value="diff" className="flex min-h-0 flex-col">
            <DiffPanel taskId={taskId} />
          </TabsContent>
        </Tabs>
      </div>
    </>
  )
}
