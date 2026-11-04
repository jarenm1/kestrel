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
  /** True when the provider refuses the stored token (revoked or expired); false when it accepts it or cannot be asked. */
  readonly tokenRejected: (token: string) => Promise<boolean>
}

/** API-key provider: the user pastes a key; no OAuth. */
export interface ApiKeyProvider extends ProviderBase {
  readonly kind: "apikey"
  /** Setup note shown under the key field. */
  readonly hint?: string
}

/** CLI provider: the user signs in with the CLI on the box; the box reports the login state. Nothing is stored here. */
export interface CliProvider extends ProviderBase {
  readonly id: CliProviderId
  readonly kind: "cli"
}

export type Provider = OAuthProvider | ApiKeyProvider | CliProvider

const githubUser = (token: string): Promise<Response> =>
  fetch("https://api.github.com/user", {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "kestrel-control-plane",
    },
  })

const githubAccount = async (token: string): Promise<Account> => {
  const res = await githubUser(token)
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

/** GitHub answers 401 only for a token it no longer honors; outages and rate limits are not a verdict on the token. */
const githubTokenRejected = async (token: string): Promise<boolean> => {
  try {
    const res = await githubUser(token)
    await res.body?.cancel()
    return res.status === 401
  } catch {
    return false
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
    tokenRejected: githubTokenRejected,
  },
  { id: "anthropic", label: "Anthropic", kind: "apikey" },
  { id: "openai", label: "OpenAI", kind: "apikey" },
  { id: "openrouter", label: "OpenRouter", kind: "apikey" },
  { id: "zai", label: "Z.ai", kind: "apikey" },
  { id: "deepseek", label: "DeepSeek", kind: "apikey" },
  { id: "minimax", label: "MiniMax", kind: "apikey" },
  { id: "claude-cli", label: "Claude subscription", kind: "cli" },
  { id: "codex-cli", label: "ChatGPT subscription", kind: "cli" },
  { id: "antigravity-cli", label: "Google account (Antigravity)", kind: "cli" },
]

export const findProvider = (id: string): Provider | undefined => PROVIDERS.find((p) => p.id === id)

/** Stored-credential providers: OAuth needs client id and secret; API-key providers are always available. */
export const isAvailable = (provider: OAuthProvider | ApiKeyProvider, env: Env): boolean =>
  provider.kind === "oauth" ? Boolean(env[provider.clientIdEnv] && env[provider.clientSecretEnv]) : true
