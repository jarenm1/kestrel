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
  /**
   * GET -> string[]: branch names of a repository the signed-in user's GitHub connection can read ("owner/name"),
   * the default branch first. 404 when GitHub is not connected or the repository is not visible.
   */
  githubBranches: (repo: string) => `/api/github/repos/${repo}/branches`,
  /** GET -> BoxStatus */
  box: "/api/box",
  /** GET -> CliAuthStatus[] for the signed-in user, served by the box (relayed); the Worker also merges it into connections. */
  cliAuth: "/api/cli-auth",
  /** GET -> ProviderUsage[]: the signed-in user's subscription limits, as each CLI reports them on the box. Relayed. */
  cliUsage: "/api/cli-auth/usage",
  /**
   * POST (no body) -> CliLoginStart: starts the provider CLI's own sign-in on the box for the signed-in
   * user, replacing any login already pending for them. Relayed to the box.
   */
  cliLogin: (provider: CliProvider) => `/api/cli-auth/${provider}/login`,
  /** POST CliLoginCodeBody -> CliAuthStatus: hands the code Anthropic showed to the pending `claude` login. Relayed. */
  cliLoginCode: (provider: CliProvider) => `/api/cli-auth/${provider}/code`,
  /** DELETE -> 204: signs the user's CLI out on the box and deletes its credentials there. Relayed. */
  cliLogout: (provider: CliProvider) => `/api/cli-auth/${provider}`,
  /**
   * POST UseBankedResetBody -> UseBankedResetResult: spends one of the user's banked resets (listed in `cliUsage`)
   * through the provider's CLI on the box. Only providers that report `bankedResets` accept it. Relayed.
   */
  cliUseBankedReset: (provider: CliProvider) => `/api/cli-auth/${provider}/banked-resets/use`,
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
  /**
   * POST -> BoxToken: a fresh box token for the signed-in user and this box: one of their own boxes, or the managed
   * box they are assigned to (`BoxList.managedBox.id`). Any other id is 404.
   */
  userBoxToken: (id: string) => `/api/boxes/${id}/token`,
  /** PUT SetActiveBoxBody -> BoxList: which box the user's apps use; `null` is Kestrel's managed box. */
  activeBox: "/api/boxes/active",
  /**
   * Box-only: GET -> BoxSelf for the box named in BOX_ID_HEADER, authenticated with `Authorization: Bearer <box
   * secret>`. How a user's own box learns its owner and the owner's connection secrets. Never reached from a browser.
   */
  boxSelf: "/box/self",
  /**
   * Box-only, managed (fleet) boxes: GET -> BoxSelf for the user named in BOX_USER_HEADER, authenticated with
   * `Authorization: Bearer <box secret>` and BOX_ID_HEADER. Answers only for users assigned to that box (403
   * otherwise), so a box can read the credentials of its own users and nobody else's. Never reached from a browser.
   */
  boxCredentials: "/box/credentials",
  /**
   * Operator-only (`Me.operator`): Kestrel's managed boxes. GET -> FleetBoxList / POST CreateFleetBoxBody ->
   * CreatedFleetBox (state `pending`). Everyone else gets 404.
   */
  fleetBoxes: "/api/fleet/boxes",
  /**
   * PATCH UpdateFleetBoxBody -> FleetBox / DELETE -> 204. Deleting unassigns its users, who are assigned to another
   * active box on their next BoxList; their threads stay on the deleted box's disk.
   */
  fleetBox: (id: string) => `/api/fleet/boxes/${id}`,
  /** POST -> CreatedFleetBox: replaces the managed box's secret; the box must be restarted with the new one. */
  fleetBoxSecret: (id: string) => `/api/fleet/boxes/${id}/secret`,
  /** Operator-only: GET `?days=` (1-90, default 30) -> ToolFailureList, most common first. Everyone else gets 404. */
  fleetToolFailures: "/api/fleet/tool-failures",
  /**
   * Box-only, Kestrel's own boxes: POST ToolFailureReport -> 204. Authenticated like the automation routes below, but
   * names no user: the counts belong to no one. A user's own box never reports. Never reached from a browser.
   */
  boxToolFailures: "/box/telemetry/tool-failures",
  /**
   * Nest host only: POST MeterBatch -> MeterIngestResult, with `Authorization: Bearer <host secret>` and
   * METER_HOST_ID_HEADER. Stores each record once per host and eventId; a retry of identical records is acknowledged
   * as duplicates. Any other caller gets 401; a record naming another host, or a conflicting replay, gets 403 or 409.
   */
  meterRecords: "/api/meter/records",
  /** Operator-only: GET -> MeterHostList / POST CreateMeterHostBody -> CreatedMeterHost. Everyone else gets 404. */
  meterHosts: "/api/meter/hosts",
  /** Operator-only: POST MeterReportBody -> MeterReport, reconciled non-billable estimates. Everyone else gets 404. */
  meterReport: "/api/meter/report",
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
   * Box-only mirror of the automation routes above (same bodies and answers, scoped to one user), for managed boxes.
   * Requires `Authorization: Bearer <box secret>` with BOX_ID_HEADER, and the acting user's login in BOX_USER_HEADER;
   * the user must be assigned to that box. The relayed box authenticates with the shared relay token instead.
   * Never reached from a browser.
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
  /** May manage Kestrel's managed boxes (`ControlPaths.fleetBoxes`); listed in the Worker's KESTREL_OPERATORS. */
  operator: Schema.Boolean,
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
  /** CLI only: why the box cannot use this CLI (e.g. it is not installed there); absent when it can. */
  error: Schema.optional(Schema.String),
  /** OAuth only: true when the provider refuses the stored token (revoked or expired), so Reconnect is needed. */
  expired: Schema.optional(Schema.Boolean),
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
  /** Why the box could not read this CLI's login (not installed, or it failed); `loggedIn` is then false. */
  error: Schema.optional(Schema.String),
})
export type CliAuthStatus = typeof CliAuthStatus.Type

/** One limit of a provider subscription, e.g. its 5-hour or weekly window. */
export const ProviderUsageWindow = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  usedPercent: Schema.Number.pipe(Schema.between(0, 100)),
  /** When the window resets; null when the provider does not say. */
  resetsAt: Schema.NullOr(Schema.String),
})
export type ProviderUsageWindow = typeof ProviderUsageWindow.Type

/** A one-time reset of a provider's limits that the user holds and spends when they choose (Codex "banked reset"). */
export const ProviderBankedReset = Schema.Struct({
  /** The provider's opaque id, sent back in `UseBankedResetBody`. */
  id: Schema.String,
  /** The provider's name for it, e.g. the promotion that granted it; null when it gives none. */
  title: Schema.NullOr(Schema.String),
  /** When it lapses unused; null when it does not expire. */
  expiresAt: Schema.NullOr(Schema.String),
})
export type ProviderBankedReset = typeof ProviderBankedReset.Type

/**
 * What a provider's CLI reports about the user's subscription limits on the box. `signed_out` covers everything with
 * no subscription to report, including API keys, which providers meter by spend instead.
 */
export const ProviderUsage = Schema.Struct({
  provider: CliProvider,
  status: Schema.Literal("ok", "signed_out", "unavailable"),
  /** The subscription as the provider names it, e.g. `max` or `pro`. */
  plan: Schema.NullOr(Schema.String),
  windows: Schema.Array(ProviderUsageWindow),
  /**
   * Banked resets the user holds, soonest to expire first. Absent when the provider's CLI does not report them
   * (Claude Code) or the box predates them. `available` can exceed `resets.length` when the provider lists only some.
   */
  bankedResets: Schema.optional(
    Schema.Struct({ available: Schema.Number, resets: Schema.Array(ProviderBankedReset) }),
  ),
  /** Why the box could not read the limits; set with `unavailable`. */
  error: Schema.optional(Schema.String),
})
export type ProviderUsage = typeof ProviderUsage.Type

export const UseBankedResetBody = Schema.Struct({ resetId: Schema.String.pipe(Schema.minLength(1)) })
export type UseBankedResetBody = typeof UseBankedResetBody.Type

/**
 * - `reset`: the reset was spent and the limits it covers are full again.
 * - `nothing_to_reset`: no covered limit is used enough to reset; the reset was kept.
 * - `no_reset`: the provider has no such reset available any more (used or expired).
 */
export const UseBankedResetResult = Schema.Struct({
  outcome: Schema.Literal("reset", "nothing_to_reset", "no_reset"),
})
export type UseBankedResetResult = typeof UseBankedResetResult.Type

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

/**
 * Header naming the box on box-only routes authenticated with a box secret (`ControlPaths.boxSelf`,
 * `ControlPaths.boxCredentials`, `ControlPaths.boxAutomations`).
 */
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

/**
 * The managed box a user is assigned to, reached directly at `url` with a token from `userBoxToken(id)`. A user keeps
 * their assignment while the box is active or draining; deleting the box reassigns them.
 */
export const ManagedBox = Schema.Struct({ id: Schema.String, url: BoxUrl })
export type ManagedBox = typeof ManagedBox.Type

export const BoxList = Schema.Struct({
  boxes: Schema.Array(UserBox),
  /** The box the user's apps use; null for Kestrel's managed box. */
  activeBoxId: Schema.NullOr(Schema.String),
  /**
   * Kestrel's managed box for this user, reached directly. Null while no managed box is active: the apps then reach
   * Kestrel's box through the control plane's relay.
   */
  managedBox: Schema.NullOr(ManagedBox),
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

/**
 * Lifecycle of a managed box. `pending`: registered, gets no users (configure and check it first). `active`: new users
 * are assigned to the active box with the fewest users. `draining`: keeps its users, gets no new ones.
 */
export const FleetBoxState = Schema.Literal("pending", "active", "draining")
export type FleetBoxState = typeof FleetBoxState.Type

/** One of Kestrel's managed boxes, as operators see it. Its secret is shown only when created or replaced. */
export const FleetBox = Schema.Struct({
  id: Schema.String,
  name: BoxName,
  url: BoxUrl,
  state: FleetBoxState,
  /** Users assigned to this box. */
  users: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  createdAt: Schema.String,
})
export type FleetBox = typeof FleetBox.Type

export const FleetBoxList = Schema.Struct({ boxes: Schema.Array(FleetBox) })
export type FleetBoxList = typeof FleetBoxList.Type

export const CreateFleetBoxBody = Schema.Struct({ name: BoxName, url: BoxUrl })
export type CreateFleetBoxBody = typeof CreateFleetBoxBody.Type

/** Every field optional. `state` can move between `active` and `draining`; nothing returns a box to `pending`. */
export const UpdateFleetBoxBody = Schema.Struct({
  name: Schema.optional(BoxName),
  url: Schema.optional(BoxUrl),
  state: Schema.optional(Schema.Literal("active", "draining")),
})
export type UpdateFleetBoxBody = typeof UpdateFleetBoxBody.Type

/**
 * The managed box and its secret. The box runs with `CLOUDAGENTS_BOX_ID`, `CLOUDAGENTS_BOX_SECRET` and
 * `CLOUDAGENTS_BOX_MANAGED=1`.
 */
export const CreatedFleetBox = Schema.Struct({ box: FleetBox, secret: Schema.String })
export type CreatedFleetBox = typeof CreatedFleetBox.Type

/** How often one failure happened: the tool, and its error with everything specific to the run scrubbed out. */
export const ToolFailureCount = Schema.Struct({
  tool: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(100)),
  signature: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(200)),
  count: Schema.Int.pipe(Schema.positive()),
})
export type ToolFailureCount = typeof ToolFailureCount.Type

export const MAX_TOOL_FAILURES_PER_REPORT = 200

export const ToolFailureReport = Schema.Struct({
  failures: Schema.Array(ToolFailureCount).pipe(Schema.maxItems(MAX_TOOL_FAILURES_PER_REPORT)),
})
export type ToolFailureReport = typeof ToolFailureReport.Type

/** One failure across all of Kestrel's boxes; `firstSeen` and `lastSeen` are UTC days (`YYYY-MM-DD`) within the window. */
export const ToolFailureSummary = Schema.Struct({
  tool: Schema.String,
  signature: Schema.String,
  count: Schema.Number,
  firstSeen: Schema.String,
  lastSeen: Schema.String,
})
export type ToolFailureSummary = typeof ToolFailureSummary.Type

export const ToolFailureList = Schema.Struct({ days: Schema.Number, failures: Schema.Array(ToolFailureSummary) })
export type ToolFailureList = typeof ToolFailureList.Type

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
