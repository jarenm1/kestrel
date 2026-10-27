import { useEffect, useState, type FormEvent } from "react"
import { ControlPaths, type Connection } from "@cloudagents/protocol"
import { api } from "../api/client"
import { SERVER_URL } from "../config"
import { errorText } from "../util"

/** API keys shorter than this are rejected by the server (`PutApiKeyBody`). */
const MIN_API_KEY_LENGTH = 8

export function ConnectionsPage() {
  const [connections, setConnections] = useState<readonly Connection[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)

  useEffect(() => {
    let active = true
    api.connections().then(
      (list) => {
        if (!active) return
        setConnections(list)
        setError(null)
      },
      (e: unknown) => {
        if (active) setError(errorText(e))
      },
    )
    return () => {
      active = false
    }
  }, [reload])

  return (
    <div className="page">
      <h1>Connections</h1>
      <div className="muted">Accounts and keys Kestrel uses on your behalf.</div>
      {error && <div className="error">{error}</div>}
      {connections === null && !error && <div className="muted">Loading…</div>}
      <ul className="list conn-list">
        {connections?.map((connection) => (
          <ConnectionRow
            key={connection.provider}
            connection={connection}
            onChanged={() => setReload((n) => n + 1)}
          />
        ))}
      </ul>
    </div>
  )
}

function ConnectionRow({ connection, onChanged }: { connection: Connection; onChanged: () => void }) {
  const [apiKey, setApiKey] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.putApiKey(connection.provider, { apiKey: apiKey.trim() })
      setApiKey("")
      onChanged()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  async function disconnect() {
    setBusy(true)
    setError(null)
    try {
      await api.deleteConnection(connection.provider)
      onChanged()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className="conn">
      <div className="conn-head">
        <strong>{connection.label}</strong>
        <span className={connection.connected ? "badge badge-ok" : "badge"}>
          {connection.connected ? "connected" : "not connected"}
        </span>
        {connection.connected && connection.account && <span className="muted mono">{connection.account}</span>}
      </div>
      {connection.kind === "oauth" ? (
        connection.available ? (
          <a className="btn" href={SERVER_URL + ControlPaths.connectOAuth(connection.provider)}>
            {connection.connected ? "Reconnect" : "Connect"}
          </a>
        ) : (
          <div className="muted">needs server config</div>
        )
      ) : (
        <form className="row-form" onSubmit={(e) => void save(e)}>
          <input
            type="password"
            autoComplete="off"
            placeholder={connection.connected ? "Replace API key" : "API key"}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
          <button type="submit" disabled={busy || apiKey.trim().length < MIN_API_KEY_LENGTH}>
            Save
          </button>
          {connection.connected && (
            <button type="button" disabled={busy} onClick={() => void disconnect()}>
              Disconnect
            </button>
          )}
        </form>
      )}
      {error && <div className="error">{error}</div>}
    </li>
  )
}
