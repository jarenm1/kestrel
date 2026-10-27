import { useLocation } from "react-router-dom"
import { ControlPaths } from "@cloudagents/protocol"
import { SERVER_URL } from "../config"

export function LoginPage() {
  const location = useLocation()
  const returnPath = location.pathname + location.search
  const loginUrl = `${SERVER_URL}${ControlPaths.login}?return=${encodeURIComponent(returnPath)}`

  return (
    <div className="login">
      <h1>Kestrel</h1>
      <p className="muted">Run your own agent harness in a sandboxed cloud box with a live desktop.</p>
      <a className="btn btn-primary" href={loginUrl}>
        Sign in with GitHub
      </a>
    </div>
  )
}
