import type { CliProvider as CliProviderId } from "@cloudagents/protocol"
import { UpstreamError } from "./http"
import type { Env } from "./env"

/** Profile of the account a connection was authorized with. */
export interface Account {
  readonly login: string
  readonly name: string | null
  readonly avatarUrl: string
}

interface ProviderBase {
  readonly id: string
  readonly label: string
}

/** OAuth provider: adding one entry here is enough to add a provider. */
export interface OAuthProvider extends ProviderBase {
  readonly kind: "oauth"
  readonly authorizeUrl: string
  readonly tokenUrl: string
  readonly scopes: string
  readonly clientIdEnv: "GITHUB_CLIENT_ID"
  readonly clientSecretEnv: "GITHUB_CLIENT_SECRET"
  /** Path on this Worker that the provider redirects back to. */
  readonly callbackPath: string
  readonly fetchAccount: (token: string) => Promise<Account>
}

/** API-key provider: the user pastes a key; no OAuth. */
export interface ApiKeyProvider extends ProviderBase {
  readonly kind: "apikey"
}

/** CLI provider: the user signs in with the CLI on the box; the box reports the login state. Nothing is stored here. */
export interface CliProvider extends ProviderBase {
  readonly id: CliProviderId
  readonly kind: "cli"
}

export type Provider = OAuthProvider | ApiKeyProvider | CliProvider

const githubAccount = async (token: string): Promise<Account> => {
  const res = await fetch("https://api.github.com/user", {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "kestrel-control-plane",
    },
  })
  if (!res.ok) throw new UpstreamError(`GitHub /user responded ${res.status}`)
  const body = (await res.json()) as { login?: unknown; name?: unknown; avatar_url?: unknown }
  if (typeof body.login !== "string" || typeof body.avatar_url !== "string") {
    throw new UpstreamError("GitHub /user returned an unexpected body")
  }
  return {
    login: body.login,
    name: typeof body.name === "string" ? body.name : null,
    avatarUrl: body.avatar_url,
  }
}

export const PROVIDERS: readonly Provider[] = [
  {
    id: "github",
    label: "GitHub",
    kind: "oauth",
    authorizeUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    scopes: "read:user repo",
    clientIdEnv: "GITHUB_CLIENT_ID",
    clientSecretEnv: "GITHUB_CLIENT_SECRET",
    // GitHub OAuth apps register a single callback URL; sign-in and re-consent share it.
    callbackPath: "/auth/github/callback",
    fetchAccount: githubAccount,
  },
  { id: "anthropic", label: "Anthropic", kind: "apikey" },
  { id: "openai", label: "OpenAI", kind: "apikey" },
  { id: "claude-cli", label: "Claude subscription", kind: "cli" },
  { id: "codex-cli", label: "ChatGPT subscription", kind: "cli" },
]

export const findProvider = (id: string): Provider | undefined => PROVIDERS.find((p) => p.id === id)

/** Stored-credential providers: OAuth needs client id and secret; API-key providers are always available. */
export const isAvailable = (provider: OAuthProvider | ApiKeyProvider, env: Env): boolean =>
  provider.kind === "oauth" ? Boolean(env[provider.clientIdEnv] && env[provider.clientSecretEnv]) : true
