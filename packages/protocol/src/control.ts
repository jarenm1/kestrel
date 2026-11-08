import { Schema } from "effect"
import { GithubRepoSlug } from "./refs"
import { AgentModel, type ModelProvider } from "./models"
import { NestBoxStatus } from "./nest"

/**
 * Control-plane API served by the Worker itself (not relayed to the box).
 * Box-specific paths such as `cliAuth` use the selected box directly, or its relay when no direct box is selected.
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
  /**
   * POST (no body) -> FileToken: a short-lived token for box files loaded where a cookie cannot be sent (a WebView or
   * DOM `<img>`). The token is accepted as `?access_token=` on GET requests for `Paths.taskAttachment`,
   * `Paths.taskRunImage` and `Paths.taskCheckoutIcon`, and on nothing else.
   */
  fileToken: "/api/file-token",
  /**
   * POST (no body) -> FileToken: a short-lived token for one task's desktop stream, for a WebView that cannot send the
   * session cookie. Accepted as `?access_token=` on `Paths.taskDesktopWs` of that task, and on nothing else.
   */
  desktopToken: (taskId: string) => `/api/tasks/${encodeURIComponent(taskId)}/desktop/token`,
  /** GET -> Me, 401 when signed out. */
  me: "/api/me",
  /** GET -> Connection[] with legacy managed/relay-box status; updated clients replace box state with `connectionsForBox`. */
  connections: "/api/connections",
  /** PUT { apiKey } for api-key providers -> Connection; DELETE -> 204. */
  connection: (provider: string) => `/api/connections/${provider}`,
  /** GET -> GithubRepo[] for the signed-in user's GitHub connection. */
  githubRepos: "/api/github/repos",
  /**
   * GET -> GithubRepo for one "owner/name"; 404 when GitHub is not connected or the repository is not visible. Unlike
   * `githubRepos` (GitHub's first page, sorted by update time), this answers for any repository the connection can read.
   */
  githubRepo: (repo: string) => `/api/github/repos/${repo}`,
  /**
   * GET -> string[]: branch names of a repository the signed-in user's GitHub connection can read ("owner/name"),
   * the default branch first. 404 when GitHub is not connected or the repository is not visible.
   */
  githubBranches: (repo: string) => `/api/github/repos/${repo}/branches`,
  /** GET -> BoxStatus */
  box: "/api/box",
  /** GET -> CliAuthStatus[] with the pre-Go provider catalog. Go-aware clients use `cliAuthFor`. */
  cliAuth: "/api/cli-auth",
  /** GET -> CliAuthStatus[] restricted to the provider literals this client can decode, on its selected box. */
  cliAuthFor: (providers: readonly CliProvider[]) => `/api/cli-auth?providers=${encodeURIComponent(providers.join(","))}`,
  /** GET -> ProviderUsage[] with the pre-Go provider catalog. Go-aware clients use `cliUsageFor`. */
  cliUsage: "/api/cli-auth/usage",
  /** GET -> ProviderUsage[] restricted to the provider literals this client can decode, on its selected box. */
  cliUsageFor: (providers: readonly CliProvider[]) => `/api/cli-auth/usage?providers=${encodeURIComponent(providers.join(","))}`,
  /**
   * POST (no body) -> CliLoginStart: starts the provider CLI's own sign-in on the box for the signed-in
   * user, replacing any login already pending for them. Only providers that sign in on a page (`CLI_SIGN_IN`). Relayed.
   */
  cliLogin: (provider: CliProvider) => `/api/cli-auth/${provider}/login`,
  /**
   * POST (no body) -> 204: cancels a sign-in still waiting on the box for this provider and removes its unfinished
   * home, so an approval completed afterwards cannot add the account. Idempotent. Relayed.
   */
  cliLoginCancel: (provider: CliProvider) => `/api/cli-auth/${provider}/login/cancel`,
  /** POST CliLoginCodeBody -> CliAuthStatus: hands the code the provider's page showed to the pending login (`needsCode`). Relayed. */
  cliLoginCode: (provider: CliProvider) => `/api/cli-auth/${provider}/code`,
  /**
   * POST PutApiKeyBody -> CliAuthStatus: signs the provider's CLI in on the box with the user's API key, replacing the
   * one it holds. Only providers that sign in with a key (`CLI_SIGN_IN`). Relayed; the key stays with the CLI on the box.
   */
  cliLoginKey: (provider: CliProvider) => `/api/cli-auth/${provider}/key`,
  /** DELETE -> 204: disconnects one account, or the active account when omitted. Relayed. */
  cliLogout: (provider: CliProvider, accountId?: string) =>
    `/api/cli-auth/${provider}${accountId === undefined ? "" : `?accountId=${encodeURIComponent(accountId)}`}`,
  /** POST { accountId } -> CliAuthStatus: selects the account used by subsequent runs and usage reads. */
  cliSelectAccount: (provider: CliProvider) => `/api/cli-auth/${provider}/account`,
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
   * Operator-only: GET -> FleetActivity, every registered box including ones that never reported. Everyone else gets
   * 404. A snapshot at least `ACTIVITY_STALE_AFTER_SECONDS` old keeps its `receivedAt` but carries no users.
   */
  fleetActivity: "/api/fleet/activity",
  /**
   * Box-only, Kestrel's own boxes: POST ToolFailureReport -> 204. Authenticated like the automation routes below, but
   * names no user: the counts belong to no one. A user's own box never reports. Never reached from a browser.
   */
  boxToolFailures: "/box/telemetry/tool-failures",
  /**
   * Box-only, managed boxes: POST BoxActivityReport -> 204. Authenticated with `Authorization: Bearer <box secret>` and
   * BOX_ID_HEADER; the relay token and user boxes are refused. The body is a full snapshot of the users with an
   * authenticated direct request to the box in the last `ACTIVITY_WINDOW_SECONDS`, sent every 30 seconds, including an
   * empty list. Never reached from a browser.
   */
  boxActivity: "/box/telemetry/activity",
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
  /**
   * Nest host only: WebSocket upgrade with `Authorization: Bearer <host secret>` and NEST_HOST_ID_HEADER (the host id
   * and secret of its `meterHosts` registration). Carries NestHostFrame up and NestControlFrame down; see `nest.ts`.
   */
  nestHostConnect: "/nest/hosts/connect",
  /** Box-only, no session: POST NestEnrollBody -> NestEnrollResult. A new Nest box trades its one-time token for its secret. */
  nestEnroll: "/box/nest/enroll",
  /** POST CreateNestBoxBody -> UserBox (with `nest`): places and creates a Nest box for the signed-in user. */
  nestBoxes: "/api/nest/boxes",
  /** POST (no body) -> UserBox: asks the box's host to resume or suspend it. Owner only; 404 otherwise. */
  nestBoxResume: (boxId: string) => `/api/nest/boxes/${encodeURIComponent(boxId)}/resume`,
  nestBoxSuspend: (boxId: string) => `/api/nest/boxes/${encodeURIComponent(boxId)}/suspend`,
  /** POST (no body) -> UserBox: backs the box up and releases its host; it resumes on the next wake. Owner only. */
  nestBoxPark: (boxId: string) => `/api/nest/boxes/${encodeURIComponent(boxId)}/park`,
  /** POST (no body) -> UserBox: attaches or detaches the box's GPU. Owner only; needs `limits.gpu` "on-demand". */
  nestBoxGpuAttach: (boxId: string) => `/api/nest/boxes/${encodeURIComponent(boxId)}/gpu/attach`,
  nestBoxGpuDetach: (boxId: string) => `/api/nest/boxes/${encodeURIComponent(boxId)}/gpu/detach`,
  /** PUT NestLimits -> UserBox: changes the box's limits (its shape). Owner only. */
  nestBoxLimits: (boxId: string) => `/api/nest/boxes/${encodeURIComponent(boxId)}/limits`,
  /** Operator-only: GET -> NestHostList. Everyone else gets 404. */
  nestHosts: "/api/nest/hosts",
} as const

/** Header the control plane's box routes read the acting user's login from; the box sets it, never a browser. */
export const BOX_USER_HEADER = "x-kestrel-box-user"

export const Me = Schema.Struct({
  login: Schema.String,
  name: Schema.NullOr(Schema.String),
  avatarUrl: Schema.String,
  /** May manage Kestrel's managed boxes (`ControlPaths.fleetBoxes`); listed in the Worker's KESTREL_OPERATORS. */
  operator: Schema.Boolean,
  /** Whether this deployment offers Nest boxes (`KESTREL_NEST_DOMAIN` is set); the app offers Create Nest box only then. */
  nestEnabled: Schema.Boolean,
})
export type Me = typeof Me.Type

export const ConnectionKind = Schema.Literal("oauth", "apikey", "cli")
export type ConnectionKind = typeof ConnectionKind.Type

/** A connected subscription identity; never includes credentials or host paths. */
export const CliAccount = Schema.Struct({
  id: Schema.String,
  account: Schema.NullOr(Schema.String),
})
export type CliAccount = typeof CliAccount.Type

export const Connection = Schema.Struct({
  provider: Schema.String, // "github", a MODEL_PROVIDERS id (API key), a CliProvider, or a legacy harness id.
  label: Schema.String, // display name
  kind: ConnectionKind,
  connected: Schema.Boolean,
  /** Account or key hint when connected, e.g. GitHub login or "sk-…a1b2". */
  account: Schema.NullOr(Schema.String),
  accounts: Schema.optional(Schema.Array(CliAccount)),
  activeAccountId: Schema.optional(Schema.String),
  /** OAuth: false when the Worker lacks client id/secret. CLI: false when the box cannot report login status. */
  available: Schema.Boolean,
  /** CLI only: why the box cannot use this CLI (e.g. it is not installed there); absent when it can. */
  error: Schema.optional(Schema.String),
  /** OAuth only: true when the provider refuses the stored token (revoked or expired), so Reconnect is needed. */
  expired: Schema.optional(Schema.Boolean),
  /** Provider-specific setup note, e.g. which Kimi key this connection accepts. */
  hint: Schema.optional(Schema.String),
})
export type Connection = typeof Connection.Type

export const PutApiKeyBody = Schema.Struct({ apiKey: Schema.String.pipe(Schema.minLength(8)) })
export type PutApiKeyBody = typeof PutApiKeyBody.Type

/** Logins of the official agent CLIs, held per user on the box. */
export const CliProvider = Schema.Literal("claude-cli", "codex-cli", "antigravity-cli", "opencode-go", "opencode", "devin-cli")
export type CliProvider = typeof CliProvider.Type

/**
 * How the user signs a CLI in: on the provider's own page (`cliLogin`, then `cliLoginCode` or a device code), or with
 * an API key they paste (`cliLoginKey`).
 */
export const CLI_SIGN_IN = {
  "claude-cli": "page",
  "codex-cli": "page",
  "antigravity-cli": "page",
  "opencode-go": "key",
  opencode: "page",
  "devin-cli": "page",
} as const satisfies Record<CliProvider, "page" | "key">
export type CliSignIn = (typeof CLI_SIGN_IN)[CliProvider]

/** One user's CLI login on the box, as reported by the box for `cliAuth`. Carries no secrets. */
export const CliAuthStatus = Schema.Struct({
  provider: CliProvider,
  loggedIn: Schema.Boolean,
  account: Schema.NullOr(Schema.String),
  accounts: Schema.optional(Schema.Array(CliAccount)),
  activeAccountId: Schema.optional(Schema.String),
  /** Why the box could not read this CLI's login (not installed, or it failed); `loggedIn` is then false. */
  error: Schema.optional(Schema.String),
  /**
   * The CLI cannot hold a login on this box at all: it is not installed, or its version cannot sign in. Distinct from
   * `error`, which may also describe a probe that failed while a login could still exist.
   */
  cannotSignIn: Schema.optional(Schema.Boolean),
})
export type CliAuthStatus = typeof CliAuthStatus.Type

/**
 * The Worker retains managed/relay-box status for installed clients. Updated clients replace that legacy state with
 * the selected box's CLI logins and the harnesses it reports, preserving stored account/key metadata.
 *
 * CLI rows use only the selected box's authentication status, never a relay box's saved login or installation state.
 * Retired standalone harness rows (`omp`, `pi`, `hermes`) are dropped.
 */
export const connectionsForBox = (
  connections: readonly Connection[],
  box: {
    readonly cliAuth: readonly CliAuthStatus[] | undefined
    readonly harnesses: readonly ModelProvider[] | undefined
    readonly error?: string
  },
): readonly Connection[] => {
  const stored = connections
    .filter((connection) => connection.kind !== "cli" || Schema.is(CliProvider)(connection.provider))
    .map((connection): Connection => {
      if (connection.kind !== "cli" || !Schema.is(CliProvider)(connection.provider)) return connection
      const status = box.cliAuth?.find((candidate) => candidate.provider === connection.provider)
      const available = status !== undefined && status.error === undefined
      const { error: _relayError, ...metadata } = connection
      const error = status?.error ?? (available ? undefined : box.error ?? "The selected box has not reported this CLI as available.")
      return {
        ...metadata,
        connected: status?.loggedIn ?? false,
        account: status?.account ?? null,
        accounts: status?.accounts,
        activeAccountId: status?.activeAccountId,
        available,
        ...(error === undefined ? {} : { error }),
      }
    })
  return stored
}

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
 * - antigravity-cli: open `url`, sign in with Google, then send the code the page shows (or its URL) to `cliLoginCode`.
 * - devin-cli: open `url`, sign in to Devin, then send the code the page shows to `cliLoginCode`.
 */
export const CliLoginStart = Schema.Struct({
  provider: CliProvider,
  accountId: Schema.optional(Schema.String),
  url: Schema.String,
  userCode: Schema.NullOr(Schema.String),
  needsCode: Schema.Boolean,
  /** ISO time after which the box abandons the pending login. */
  expiresAt: Schema.String,
})
export type CliLoginStart = typeof CliLoginStart.Type

export const CliLoginCodeBody = Schema.Struct({
  code: Schema.String.pipe(Schema.minLength(1)),
  accountId: Schema.optional(Schema.String),
})
export type CliLoginCodeBody = typeof CliLoginCodeBody.Type

export const CliSelectAccountBody = Schema.Struct({
  accountId: Schema.String.pipe(Schema.minLength(1)),
})
export type CliSelectAccountBody = typeof CliSelectAccountBody.Type

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
  /** Set when the box is a Nest VM: its state and size. Absent for a user's own machine. */
  nest: Schema.optional(NestBoxStatus),
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

/**
 * A token that stands in for the session cookie on box files a WebView or DOM `<img>` loads (`ControlPaths.fileToken`).
 * It names the user who minted it, only loads files (`Paths.taskAttachment`, `Paths.taskRunImage`,
 * `Paths.taskCheckoutIcon`), and expires one hour after it is minted.
 */
export const FileToken = Schema.Struct({
  token: Schema.String,
  /** ISO time the token expires. */
  expiresAt: Schema.String,
})
export type FileToken = typeof FileToken.Type

/** What a user's own box gets from `ControlPaths.boxSelf`. Host-side only: never passed into a sandbox. */
export const BoxSelf = Schema.Struct({
  owner: Schema.String,
  /** Matches the `cv` claim of tokens minted while these credentials were current. */
  credentialsVersion: Schema.String,
  github: Schema.optional(Schema.String),
  /** Model API keys by `ModelProvider` id. */
  providers: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
  /** Legacy Anthropic/OpenAI slots, still sent so boxes older than `providers` keep their keys. */
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

/** How far back a box activity report looks; a user with an authenticated request in this window is active. */
export const ACTIVITY_WINDOW_SECONDS = 5 * 60

/** After this long without a report, a box's snapshot is stale: its users are no longer counted as active. */
export const ACTIVITY_STALE_AFTER_SECONDS = 90

/** Users one box reports. A full snapshot beyond this is refused rather than stored. */
export const MAX_BOX_ACTIVITY_USERS = 10_000

/** Box clocks may run this far ahead of the receiver; timestamp further ahead is a future timestamp, refused. */
export const MAX_ACTIVITY_CLOCK_SKEW_SECONDS = 30

/** Largest body `ControlPaths.boxActivity` reads. A full 10,000-user snapshot is well under it. */
export const MAX_BOX_ACTIVITY_BODY_BYTES = 2 * 1024 * 1024

/** A UTC timestamp with milliseconds, as `Date.toISOString` writes it. */
export const ActivityTimestamp = Schema.String.pipe(
  Schema.pattern(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/),
  Schema.filter((value) =>
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value ? true : "not a valid UTC timestamp",
  ),
)

/**
 * One user with an authenticated request to the box in the activity window. `lastActiveAt` is when the box last served
 * such a request; it says nothing about human attention or a running agent.
 */
export const BoxActivityUser = Schema.Struct({
  login: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(100)),
  lastActiveAt: ActivityTimestamp,
})
export type BoxActivityUser = typeof BoxActivityUser.Type

/** A managed box's full activity snapshot. An empty `users` retires every user in the previous snapshot. */
export const BoxActivityReport = Schema.Struct({
  users: Schema.Array(BoxActivityUser).pipe(Schema.maxItems(MAX_BOX_ACTIVITY_USERS)),
})
export type BoxActivityReport = typeof BoxActivityReport.Type

/** One registered managed box's latest snapshot; `receivedAt` is the control plane's clock, null if it never reported. */
export const FleetActivityBox = Schema.Struct({
  boxId: Schema.String,
  receivedAt: Schema.NullOr(ActivityTimestamp),
  users: Schema.Array(BoxActivityUser),
})
export type FleetActivityBox = typeof FleetActivityBox.Type

/**
 * Active users per registered managed box. A box whose snapshot is at least `staleAfterSeconds` old keeps its
 * `receivedAt` but has no `users`, so a stale snapshot never reads as a current count.
 */
export const FleetActivity = Schema.Struct({
  windowSeconds: Schema.Number,
  staleAfterSeconds: Schema.Number,
  boxes: Schema.Array(FleetActivityBox),
})
export type FleetActivity = typeof FleetActivity.Type

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

/**
 * The portable part of an automation, as carried by a share link. It holds what decides how the imported copy runs,
 * never the owner's id, run history, timestamps or enabled state: the recipient imports a disabled copy of their own.
 */
export const AutomationShare = Schema.Struct({
  version: Schema.Literal(1),
  name: Schema.String.pipe(Schema.minLength(1)),
  /** The sharer's repository; the recipient may only use it if their GitHub connection can read it. */
  repo: Schema.NullOr(GithubRepoSlug),
  prompt: Schema.String.pipe(Schema.minLength(1)),
  model: Schema.optionalWith(Schema.NullOr(AgentModel), { default: () => null, exact: true }),
  trigger: AutomationTrigger,
})
export type AutomationShare = typeof AutomationShare.Type

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
