import { Schema } from "effect"
import { GithubRepoSlug } from "./refs"
import { AgentModel } from "./models"

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
  /** GET -> Automation[] / POST CreateAutomationBody -> Automation: the signed-in user's automations. */
  automations: "/api/automations",
  /** GET -> Automation / PATCH UpdateAutomationBody -> Automation / DELETE -> 204. Other users' ids are 404. */
  automation: (id: string) => `/api/automations/${id}`,
  /** GET -> AutomationRun[] (newest first). */
  automationRuns: (id: string) => `/api/automations/${id}/runs`,
  /** POST TriggerAutomationBody -> AutomationRun: "run now". */
  automationTrigger: (id: string) => `/api/automations/${id}/trigger`,
  /**
   * The signed-in user's own boxes (bring your own box). GET -> BoxList / POST CreateBoxBody -> CreatedBox.
   * The app talks to the active box directly at its `url` with a box token instead of through the relay.
   */
  boxes: "/api/boxes",
  /** PATCH UpdateBoxBody -> UserBox / DELETE -> 204 (clears it as the active box). Other users' ids are 404. */
  userBox: (id: string) => `/api/boxes/${id}`,
  /** POST -> CreatedBox: replaces the box's secret; tokens signed with the old one stop working. */
  userBoxSecret: (id: string) => `/api/boxes/${id}/secret`,
  /** POST -> BoxToken: a fresh box token for the signed-in user and this box. */
  userBoxToken: (id: string) => `/api/boxes/${id}/token`,
  /** PUT SetActiveBoxBody -> BoxList: which box the user's apps use; `null` is Kestrel's relayed box. */
  activeBox: "/api/boxes/active",
  /**
   * Box-only: GET -> BoxSelf for the box named in BOX_ID_HEADER, authenticated with `Authorization: Bearer <box
   * secret>`. How a user's own box learns its owner and the owner's connection secrets. Never reached from a browser.
   */
  boxSelf: "/box/self",
  /**
   * Pairing a box from the `kestrel-box` CLI, no auth. POST PairingStartBody -> PairingStart: the CLI shows `code` and
   * `approveUrl`, then polls `boxPairingPoll` with the secret `pairingId` until the signed-in user approves the code.
   */
  boxPairing: "/box/pairings",
  /** POST PairingPollBody -> PairingPoll. The approved box and its secret are handed out once, then forgotten. */
  boxPairingPoll: "/box/pairings/poll",
  /** App page where the signed-in user approves a pairing code (`?code=`). Not an API route. */
  pairPage: "/pair",
  /** GET -> PendingPairing for the approval page; 404 when unknown or expired. */
  pairing: (code: string) => `/api/boxes/pairings/${code}`,
  /** POST ApprovePairingBody -> BoxList: creates the box for the signed-in user (optionally making it active). */
  pairingApprove: (code: string) => `/api/boxes/pairings/${code}/approve`,
  /**
   * Box-only mirror of the automation routes above (same bodies and answers, scoped to one user). Requires
   * `Authorization: Bearer <box token>` and the acting user's login in BOX_USER_HEADER. Never reached from a browser.
   */
  boxAutomations: "/box/automations",
  boxAutomation: (id: string) => `/box/automations/${id}`,
  /** POST: GitHub repository webhook receiver. No session; authenticated by X-Hub-Signature-256. */
  githubWebhook: "/webhooks/github",
} as const

/** Header the control plane's box routes read the acting user's login from; the box sets it, never a browser. */
export const BOX_USER_HEADER = "x-kestrel-box-user"

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

/** Header naming the box on box-only routes authenticated with a box secret (`ControlPaths.boxSelf`). */
export const BOX_ID_HEADER = "x-kestrel-box-id"

/** At most this many boxes per user. */
export const MAX_USER_BOXES = 10

/**
 * A box's public base URL: an origin only, `https://`, or `http://` on loopback (`localhost`, `127.0.0.1`, `[::1]`)
 * since browsers treat those as secure. The app on an HTTPS origin cannot reach plain HTTP anywhere else.
 */
export const BoxUrl = Schema.String.pipe(
  Schema.filter((value) => {
    let url: URL
    try {
      url = new URL(value)
    } catch {
      return "not a URL"
    }
    if (url.origin !== value) return "must be an origin only, like https://box.example.com (no path or trailing slash)"
    if (url.protocol === "https:") return true
    if (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return true
    return "must be https://, or http:// on localhost"
  }),
)

export const BoxName = Schema.String.pipe(Schema.trimmed(), Schema.minLength(1), Schema.maxLength(64))

/** One of a user's own boxes. Its secret is shown only when created or replaced (`CreatedBox`). */
export const UserBox = Schema.Struct({
  id: Schema.String,
  name: BoxName,
  url: BoxUrl,
  createdAt: Schema.String,
})
export type UserBox = typeof UserBox.Type

export const BoxList = Schema.Struct({
  boxes: Schema.Array(UserBox),
  /** The box the user's apps use; null for Kestrel's relayed box. */
  activeBoxId: Schema.NullOr(Schema.String),
})
export type BoxList = typeof BoxList.Type

export const CreateBoxBody = Schema.Struct({ name: BoxName, url: BoxUrl })
export type CreateBoxBody = typeof CreateBoxBody.Type

export const UpdateBoxBody = Schema.Struct({ name: Schema.optional(BoxName), url: Schema.optional(BoxUrl) })
export type UpdateBoxBody = typeof UpdateBoxBody.Type

/** The box and its secret, which the box is configured with (`CLOUDAGENTS_BOX_ID`, `CLOUDAGENTS_BOX_SECRET`). */
export const CreatedBox = Schema.Struct({ box: UserBox, secret: Schema.String })
export type CreatedBox = typeof CreatedBox.Type

export const SetActiveBoxBody = Schema.Struct({ boxId: Schema.NullOr(Schema.String) })
export type SetActiveBoxBody = typeof SetActiveBoxBody.Type

/** A box token (see `boxtoken.ts`) and where to use it: `Authorization: Bearer <token>`, or BOX_TOKEN_QUERY. */
export const BoxToken = Schema.Struct({
  token: Schema.String,
  url: BoxUrl,
  /** ISO time the token expires. */
  expiresAt: Schema.String,
})
export type BoxToken = typeof BoxToken.Type

/** What a user's own box gets from `ControlPaths.boxSelf`. Host-side only: never passed into a sandbox. */
export const BoxSelf = Schema.Struct({
  owner: Schema.String,
  /** Matches the `cv` claim of tokens minted while these credentials were current. */
  credentialsVersion: Schema.String,
  github: Schema.optional(Schema.String),
  anthropic: Schema.optional(Schema.String),
  openai: Schema.optional(Schema.String),
})
export type BoxSelf = typeof BoxSelf.Type

/** How long a pairing code stays valid. */
export const PAIRING_TTL_SECONDS = 10 * 60

/** What the CLI suggests for the new box; the user can change both before approving. */
export const PairingStartBody = Schema.Struct({
  name: Schema.optional(BoxName),
  url: Schema.optional(BoxUrl),
})
export type PairingStartBody = typeof PairingStartBody.Type

export const PairingStart = Schema.Struct({
  /** Secret the CLI polls with; never shown to the user. */
  pairingId: Schema.String,
  /** Short code the user approves in the app, e.g. "KQ7M-4TXP". */
  code: Schema.String,
  /** `<app origin>/pair?code=<code>`. */
  approveUrl: Schema.String,
  expiresAt: Schema.String,
})
export type PairingStart = typeof PairingStart.Type

export const PairingPollBody = Schema.Struct({ pairingId: Schema.String })
export type PairingPollBody = typeof PairingPollBody.Type

export const PairingPoll = Schema.Union(
  Schema.Struct({ status: Schema.Literal("pending"), expiresAt: Schema.String }),
  Schema.Struct({ status: Schema.Literal("approved"), box: UserBox, secret: Schema.String }),
)
export type PairingPoll = typeof PairingPoll.Type

export const PendingPairing = Schema.Struct({
  code: Schema.String,
  name: Schema.NullOr(BoxName),
  url: Schema.NullOr(BoxUrl),
  expiresAt: Schema.String,
})
export type PendingPairing = typeof PendingPairing.Type

export const ApprovePairingBody = Schema.Struct({ name: BoxName, url: BoxUrl, activate: Schema.Boolean })
export type ApprovePairingBody = typeof ApprovePairingBody.Type

/** GitHub pull-request webhook events an automation can start on (`pull_request` action, prefixed). */
export const GithubAutomationEvent = Schema.Literal(
  "pull_request.opened",
  "pull_request.reopened",
  "pull_request.ready_for_review",
  "pull_request.synchronize",
  "pull_request.review_requested",
)
export type GithubAutomationEvent = typeof GithubAutomationEvent.Type

/**
 * When an automation starts a thread.
 * - schedule: 5-field cron (minute hour day-of-month month day-of-week; `*`, lists, ranges, steps; 0 and 7 are Sunday)
 *   evaluated in an IANA `timezone`, e.g. `0 13 * * 2` in `America/New_York` is Tuesdays at 13:00.
 * - github: fires on matching pull request events of the automation's `repo` (required for this trigger). `reviewers` filters
 *   `pull_request.review_requested` by the requested reviewer's login (case-insensitive); `baseBranches` keeps
 *   only PRs targeting those branches; `includeDrafts` (default false) also fires on draft PRs. An absent or empty
 *   list means no filter.
 */
export const AutomationTrigger = Schema.Union(
  Schema.Struct({
    _tag: Schema.Literal("schedule"),
    cron: Schema.String,
    timezone: Schema.String,
  }),
  Schema.Struct({
    _tag: Schema.Literal("github"),
    events: Schema.NonEmptyArray(GithubAutomationEvent),
    reviewers: Schema.optional(Schema.Array(Schema.String)),
    baseBranches: Schema.optional(Schema.Array(Schema.String)),
    includeDrafts: Schema.optional(Schema.Boolean),
  }),
)
export type AutomationTrigger = typeof AutomationTrigger.Type

export const Automation = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  /**
   * GitHub "owner/name" the automation works on, or null for one that starts a thread with no repository.
   * Its threads start with this repository checked out (at the pull request head for github triggers).
   */
  repo: Schema.NullOr(Schema.String),
  prompt: Schema.String,
  /** Null uses the box's default model. Older responses omit the field; decode those to the same default. */
  model: Schema.optionalWith(Schema.NullOr(AgentModel), { default: () => null, exact: true }),
  enabled: Schema.Boolean,
  trigger: AutomationTrigger,
  createdAt: Schema.String, // ISO-8601
  updatedAt: Schema.String, // ISO-8601
  /** Next scheduled fire (ISO-8601); schedule automations only, null otherwise or when disabled. */
  nextRunAt: Schema.NullOr(Schema.String),
})
export type Automation = typeof Automation.Type

export const CreateAutomationBody = Schema.Struct({
  name: Schema.String.pipe(Schema.minLength(1)),
  /** GitHub "owner/name" the owner's GitHub connection can read. Required for github triggers, optional for schedules. */
  repo: Schema.optional(GithubRepoSlug),
  prompt: Schema.String.pipe(Schema.minLength(1)),
  model: Schema.optional(Schema.NullOr(AgentModel)),
  trigger: AutomationTrigger,
  enabled: Schema.optional(Schema.Boolean),
}).pipe(
  Schema.filter((body) => body.trigger._tag !== "github" || body.repo !== undefined || "github triggers need a repo"),
)
export type CreateAutomationBody = typeof CreateAutomationBody.Type

/** Every field optional; `repo` cannot change. */
export const UpdateAutomationBody = Schema.Struct({
  name: Schema.optional(Schema.String.pipe(Schema.minLength(1))),
  prompt: Schema.optional(Schema.String.pipe(Schema.minLength(1))),
  /** Omitted preserves the selection; null restores the box default. */
  model: Schema.optional(Schema.NullOr(AgentModel)),
  trigger: Schema.optional(AutomationTrigger),
  enabled: Schema.optional(Schema.Boolean),
})
export type UpdateAutomationBody = typeof UpdateAutomationBody.Type

/** One attempt to start a thread for an automation. `started` has a `taskId`; `failed` has an `error`. */
export const AutomationRun = Schema.Struct({
  id: Schema.String,
  automationId: Schema.String,
  firedAt: Schema.String, // ISO-8601
  /** "schedule", "manual", "manual #12", or the webhook event, e.g. "pull_request.opened #12". */
  reason: Schema.String,
  status: Schema.Literal("started", "failed"),
  taskId: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
})
export type AutomationRun = typeof AutomationRun.Type

/** Manual "run now". `pullRequest` is required for github automations and rejected for schedules. */
export const TriggerAutomationBody = Schema.Struct({
  pullRequest: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.positive())),
})
export type TriggerAutomationBody = typeof TriggerAutomationBody.Type
