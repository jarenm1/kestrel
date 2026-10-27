import { Schema } from "effect"

/**
 * Control-plane API served by the Worker itself (not relayed to the box).
 * All other `/api/*` paths are relayed to the agent box. `cliAuth` is one of them; the Worker also calls it to merge connections.
 * Requests authenticate with the `session` cookie set by the GitHub OAuth callback;
 * unauthenticated `/api/*` requests get 401 `{ _tag: "Unauthorized", message }`.
 */
export const ControlPaths = {
  /** GET: redirect to GitHub OAuth (sign-in). Query `?return=/path` optional. */
  login: "/auth/github/login",
  /** GET: OAuth callback for sign-in. */
  loginCallback: "/auth/github/callback",
  /** POST: clears the session; 204. */
  logout: "/auth/logout",
  /** GET: redirect to the provider's OAuth consent to add/refresh a connection. */
  connectOAuth: (provider: string) => `/auth/connect/${provider}`,
  /** GET: OAuth callback for connections. */
  connectCallback: (provider: string) => `/auth/connect/${provider}/callback`,
  /** GET -> Me, 401 when signed out. */
  me: "/api/me",
  /** GET -> Connection[] */
  connections: "/api/connections",
  /** PUT { apiKey } for api-key providers -> Connection; DELETE -> 204. */
  connection: (provider: string) => `/api/connections/${provider}`,
  /** GET -> GithubRepo[] for the signed-in user's GitHub connection. */
  githubRepos: "/api/github/repos",
  /** GET -> BoxStatus */
  box: "/api/box",
  /** GET -> CliAuthStatus[] for the signed-in user, served by the box (relayed); the Worker also merges it into connections. */
  cliAuth: "/api/cli-auth",
  /**
   * POST (no body) -> CliLoginStart: starts the provider CLI's own sign-in on the box for the signed-in
   * user, replacing any login already pending for them. Relayed to the box.
   */
  cliLogin: (provider: CliProvider) => `/api/cli-auth/${provider}/login`,
  /** POST CliLoginCodeBody -> CliAuthStatus: hands the code Anthropic showed to the pending `claude` login. Relayed. */
  cliLoginCode: (provider: CliProvider) => `/api/cli-auth/${provider}/code`,
  /** DELETE -> 204: signs the user's CLI out on the box and deletes its credentials there. Relayed. */
  cliLogout: (provider: CliProvider) => `/api/cli-auth/${provider}`,
} as const

export const Me = Schema.Struct({
  login: Schema.String,
  name: Schema.NullOr(Schema.String),
  avatarUrl: Schema.String,
})
export type Me = typeof Me.Type

export const ConnectionKind = Schema.Literal("oauth", "apikey", "cli")
export type ConnectionKind = typeof ConnectionKind.Type

export const Connection = Schema.Struct({
  provider: Schema.String, // "github" | "anthropic" | "openai" | "claude-cli" | "codex-cli"
  label: Schema.String, // display name
  kind: ConnectionKind,
  connected: Schema.Boolean,
  /** Account or key hint when connected, e.g. GitHub login or "sk-…a1b2". */
  account: Schema.NullOr(Schema.String),
  /** OAuth: false when the Worker lacks client id/secret. CLI: false when the box cannot report login status. */
  available: Schema.Boolean,
})
export type Connection = typeof Connection.Type

export const PutApiKeyBody = Schema.Struct({ apiKey: Schema.String.pipe(Schema.minLength(8)) })
export type PutApiKeyBody = typeof PutApiKeyBody.Type

/** Subscription logins of the official agent CLIs, held per user on the box. */
export const CliProvider = Schema.Literal("claude-cli", "codex-cli")
export type CliProvider = typeof CliProvider.Type

/** One user's CLI login on the box, as reported by the box for `cliAuth`. Carries no secrets. */
export const CliAuthStatus = Schema.Struct({
  provider: CliProvider,
  loggedIn: Schema.Boolean,
  account: Schema.NullOr(Schema.String),
})
export type CliAuthStatus = typeof CliAuthStatus.Type

/**
 * A sign-in the box started with the unmodified CLI. The user finishes it on the provider's own page:
 * - claude-cli: open `url`, sign in, then send the code Anthropic shows to `cliLoginCode` (`needsCode`).
 * - codex-cli: open `url` and enter `userCode`; the box notices completion itself (poll `cliAuth`).
 */
export const CliLoginStart = Schema.Struct({
  provider: CliProvider,
  url: Schema.String,
  userCode: Schema.NullOr(Schema.String),
  needsCode: Schema.Boolean,
  /** ISO time after which the box abandons the pending login. */
  expiresAt: Schema.String,
})
export type CliLoginStart = typeof CliLoginStart.Type

export const CliLoginCodeBody = Schema.Struct({ code: Schema.String.pipe(Schema.minLength(1)) })
export type CliLoginCodeBody = typeof CliLoginCodeBody.Type

export const GithubRepo = Schema.Struct({
  fullName: Schema.String, // "owner/name"
  cloneUrl: Schema.String, // https clone URL
  private: Schema.Boolean,
  defaultBranch: Schema.String,
  updatedAt: Schema.String,
})
export type GithubRepo = typeof GithubRepo.Type

export const BoxStatus = Schema.Struct({
  online: Schema.Boolean,
  connectedAt: Schema.NullOr(Schema.String),
  boxVersion: Schema.NullOr(Schema.String),
})
export type BoxStatus = typeof BoxStatus.Type
