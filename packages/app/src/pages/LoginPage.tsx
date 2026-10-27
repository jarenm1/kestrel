import { useLocation } from "react-router-dom"
import { ControlPaths } from "@cloudagents/protocol"
import { Button } from "@/components/ui/button"
import { SERVER_URL } from "@/config"

export function LoginPage() {
  const location = useLocation()
  const returnPath = location.pathname + location.search
  const loginUrl = `${SERVER_URL}${ControlPaths.login}?return=${encodeURIComponent(returnPath)}`

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="text-3xl font-semibold tracking-tight">Kestrel</h1>
      <p className="max-w-md text-muted-foreground">
        Run your own agent harness in a sandboxed cloud box with a live desktop.
      </p>
      <Button asChild size="lg">
        <a href={loginUrl}>Sign in with GitHub</a>
      </Button>
    </div>
  )
}
