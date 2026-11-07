import { Schema } from "effect";
import {
  AgentModel,
  Automation,
  AutomationRun,
  BOX_TOKEN_QUERY,
  BoxCapabilities,
  BoxList,
  BoxStatus,
  BoxToken,
  CliAuthStatus,
  CliLoginCodeBody,
  CliLoginStart,
  CliProvider,
  Connection,
  connectionsForBox,
  ControlPaths,
  CreateAutomationBody,
  CreateTaskBody,
  DesktopStatus,
  DiffResponse,
  FileToken,
  GithubRepo,
  Health,
  HarnessCommands,
  Me,
  Message,
  type ModelProvider,
  Paths,
  PreviewSession,
  ProviderUsage,
  PutApiKeyBody,
  Run,
  RunItems,
  SendMessageBody,
  SendMessageResponse,
  Task,
  TextGenerationSettings,
  ThreadSettings,
  TriggerAutomationBody,
  UpdateAutomationBody,
  Usage,
  UsageActivity,
  type UseBankedResetBody,
  UseBankedResetResult,
  type UserBox,
} from "@cloudagents/protocol";
import { fetchCredentials } from "@/auth/session";
import { ApiError, responseError } from "./errors";

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** A box the apps reach directly: the user's own box, or their managed box. `null` everywhere means Kestrel's box, relayed by the Worker. */
export type ActiveBox = Pick<UserBox, "id" | "url">;

/** Whether two active boxes are the same route; `null` (Kestrel's relayed box) only matches `null`. */
export function sameBox(a: ActiveBox | null, b: ActiveBox | null): boolean {
  if (a === null || b === null) return a === b;
  return a.id === b.id && a.url === b.url;
}

/** Image source for a box file; it needs the session cookie, or the box token, so it is passed as request headers or a query. */
export interface FileSource {
  uri: string;
  headers: Record<string, string>;
}

/**
 * How a WebView or DOM `<img>` loads box files: `${base}${path}${query}`. Nothing here can send a Cookie header, so the
 * query carries a token instead; refresh before `expiresAt` (epoch ms).
 */
export interface FileAccess {
  readonly base: string;
  readonly query: string;
  readonly expiresAt: number;
}

/** A minted box token is replaced this long before the box says it expires. */
const TOKEN_REFRESH_MARGIN_MS = 60_000;

/** The desktop viewer page on the app host. Its ws URL and task id travel in the fragment, which the server never sees. */
const DESKTOP_EMBED_PATH = "/embed/desktop";

/** Typed client for the control plane and the agent box, bound to one server URL, session and active box. */
export interface ApiClient {
  /** Stable identity for box-served cache entries; includes URL so a changed route cannot reuse old data. */
  readonly boxScope: string;
  /** Source of a file the box serves (`Paths.taskAttachment`, `Paths.taskCheckoutIcon`). */
  fileSource(path: string): Promise<FileSource>;
  /** Source of any box file for a WebView or DOM `<img>`: `${base}${path}${query}`, valid until `expiresAt` (epoch ms). */
  fileAccess(): Promise<FileAccess>;
  /** A WebSocket URL for a box path (`Paths.*Ws`), carrying the box token when the active box is reached directly. */
  socketUrl(path: string): Promise<string>;
  /**
   * The WebSocket URL for a task's desktop stream, which carries its own auth: the embed page holds no session. A box
   * token on a user box, a desktop token on the relayed box. `fresh` mints a new one.
   */
  desktopSocketUrl(taskId: string, options?: { fresh?: boolean }): Promise<string>;
  /** The desktop embed page URL for a task, given the stream's ws URL from `desktopSocketUrl`. */
  desktopEmbedUrl(taskId: string, ws: string): string;
  /** The sandboxed preview frame URL for a preview session token minted by `previewSession`. */
  previewFrameUrl(taskId: string, token: string): string;

  me(): Promise<Me>;
  logout(): Promise<void>;
  connections(): Promise<readonly Connection[]>;
  putApiKey(provider: string, body: PutApiKeyBody): Promise<Connection>;
  deleteConnection(provider: string): Promise<void>;
  githubRepos(): Promise<readonly GithubRepo[]>;
  /** Branch names of a GitHub repository, its default branch first; 404 without a GitHub connection or access. */
  githubBranches(repo: string): Promise<readonly string[]>;
  boxes(): Promise<BoxList>;
  setActiveBox(boxId: string | null): Promise<BoxList>;
  box(): Promise<BoxStatus>;
  cliLoginStart(provider: CliProvider): Promise<CliLoginStart>;
  cliLoginCode(provider: CliProvider, body: CliLoginCodeBody): Promise<CliAuthStatus>;
  cliLoginKey(provider: CliProvider, body: PutApiKeyBody): Promise<CliAuthStatus>;
  cliLogout(provider: CliProvider): Promise<void>;
  listAutomations(): Promise<readonly Automation[]>;
  createAutomation(body: CreateAutomationBody): Promise<Automation>;
  updateAutomation(id: string, body: UpdateAutomationBody): Promise<Automation>;
  deleteAutomation(id: string): Promise<void>;
  listAutomationRuns(id: string): Promise<readonly AutomationRun[]>;
  triggerAutomation(id: string, body: TriggerAutomationBody): Promise<AutomationRun>;

  listTasks(): Promise<readonly Task[]>;
  createTask(body: CreateTaskBody): Promise<Task>;
  getTask(taskId: string): Promise<Task>;
  archiveTask(taskId: string): Promise<Task>;
  unarchiveTask(taskId: string): Promise<Task>;
  listMessages(taskId: string): Promise<readonly Message[]>;
  sendMessage(taskId: string, body: SendMessageBody): Promise<SendMessageResponse>;
  listRuns(taskId: string): Promise<readonly Run[]>;
  runItems(runId: string): Promise<RunItems>;
  cancelRun(runId: string): Promise<Run>;
  /** Turns a thread's armed usage-limit auto-resume on or off; the box answers with the thread as stored. */
  setUsageLimitAutoResume(taskId: string, autoResume: boolean): Promise<Task>;
  getDiff(taskId: string): Promise<DiffResponse>;
  getDesktop(taskId: string): Promise<DesktopStatus>;
  startDesktop(taskId: string): Promise<DesktopStatus>;
  stopDesktop(taskId: string): Promise<void>;
  usage(): Promise<Usage>;
  /** The CLI providers' plan limits on the active box. */
  providerUsage(): Promise<readonly ProviderUsage[]>;
  /** What the active box can run, as it found at startup. */
  capabilities(): Promise<BoxCapabilities>;
  useBankedReset(provider: CliProvider, body: UseBankedResetBody): Promise<UseBankedResetResult>;
  /** Runs per day, counted in the device's time zone so the days match the user's calendar. */
  usageActivity(): Promise<UsageActivity>;
  /** The signed-in user's generated-text preferences on this box. */
  textGenerationSettings(): Promise<TextGenerationSettings>;
  /** Replaces the generated-text preferences on this box; values are validated by the server before it saves. */
  saveTextGenerationSettings(settings: TextGenerationSettings): Promise<TextGenerationSettings>;
  /** The signed-in user's thread preferences on this box. */
  threadSettings(): Promise<ThreadSettings>;
  /** Replaces the thread preferences on this box. */
  saveThreadSettings(settings: ThreadSettings): Promise<ThreadSettings>;
  commands(taskId: string, model: AgentModel): Promise<HarnessCommands>;
  previewSession(taskId: string): Promise<PreviewSession>;
}

/** One HTTP exchange; the caller supplies the full URL and the auth headers. Responses are decoded with protocol schemas. */
async function send<A, I>(
  schema: Schema.Schema<A, I, never>,
  method: Method,
  url: string,
  headers: Record<string, string>,
  body?: unknown
): Promise<A> {
  const requestHeaders: Record<string, string> = { ...headers };
  if (body !== undefined) requestHeaders["Content-Type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: requestHeaders,
      // Native: RN's cookie jar would append a second session to our explicit Cookie header. Web: the browser's cookie.
      credentials: fetchCredentials,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new ApiError(0, `Cannot reach server at ${new URL(url).origin}: ${String(e)}`);
  }

  const text = await res.text();
  if (!res.ok) throw responseError(res.status, text, res.statusText);

  // 204 and other empty bodies carry no JSON; they decode as `undefined`.
  let json: unknown;
  try {
    json = text === "" ? undefined : JSON.parse(text);
  } catch {
    throw new ApiError(res.status, "Server returned invalid JSON");
  }
  try {
    return await Schema.decodeUnknownPromise(schema)(json);
  } catch (e) {
    throw new ApiError(res.status, `Unexpected response shape: ${String(e)}`);
  }
}

/** Creates an API client bound to one server URL, session cookie and active box (`null` for the relayed Kestrel box). */
export function createApiClient(
  serverUrl: string,
  sessionCookie: string | null,
  activeBox: ActiveBox | null
): ApiClient {
  const cookieHeaders: Record<string, string> = sessionCookie ? { Cookie: `session=${sessionCookie}` } : {};

  // The user's box token, single-flight: concurrent callers share one mint, and a failed mint is not kept.
  let boxToken: { minted: Promise<{ token: string; expiresAt: number }>; refreshAt: number } | null = null;
  function mintBoxToken(box: ActiveBox, fresh = false): Promise<{ token: string; expiresAt: number }> {
    if (fresh) boxToken = null;
    if (boxToken && Date.now() < boxToken.refreshAt) return boxToken.minted;
    const entry: { minted: Promise<{ token: string; expiresAt: number }>; refreshAt: number } = {
      refreshAt: Number.POSITIVE_INFINITY,
      minted: request(BoxToken, "POST", ControlPaths.userBoxToken(box.id)).then(
        (minted) => {
          entry.refreshAt = Date.parse(minted.expiresAt) - TOKEN_REFRESH_MARGIN_MS;
          return { token: minted.token, expiresAt: Date.parse(minted.expiresAt) };
        },
        (error: unknown) => {
          if (boxToken === entry) boxToken = null;
          throw error;
        }
      ),
    };
    boxToken = entry;
    return entry.minted;
  }

  // A file token for the relayed box, single-flight in the same way: reused until a minute before it expires.
  let fileToken: { minted: Promise<FileToken>; refreshAt: number } | null = null;
  function mintFileToken(): Promise<FileToken> {
    if (fileToken && Date.now() < fileToken.refreshAt) return fileToken.minted;
    const entry: { minted: Promise<FileToken>; refreshAt: number } = {
      refreshAt: Number.POSITIVE_INFINITY,
      minted: request(FileToken, "POST", ControlPaths.fileToken).then(
        (minted) => {
          entry.refreshAt = Date.parse(minted.expiresAt) - TOKEN_REFRESH_MARGIN_MS;
          return minted;
        },
        (error: unknown) => {
          if (fileToken === entry) fileToken = null;
          throw error;
        }
      ),
    };
    fileToken = entry;
    return entry.minted;
  }

  // A desktop token for the relayed box, single-flight per task in the same way.
  let desktopToken: { taskId: string; minted: Promise<FileToken>; refreshAt: number } | null = null;
  function mintDesktopToken(taskId: string, fresh: boolean): Promise<FileToken> {
    if (!fresh && desktopToken?.taskId === taskId && Date.now() < desktopToken.refreshAt) return desktopToken.minted;
    const entry: { taskId: string; minted: Promise<FileToken>; refreshAt: number } = {
      taskId,
      refreshAt: Number.POSITIVE_INFINITY,
      minted: request(FileToken, "POST", ControlPaths.desktopToken(taskId)).then(
        (minted) => {
          entry.refreshAt = Date.parse(minted.expiresAt) - TOKEN_REFRESH_MARGIN_MS;
          return minted;
        },
        (error: unknown) => {
          if (desktopToken === entry) desktopToken = null;
          throw error;
        }
      ),
    };
    desktopToken = entry;
    return entry.minted;
  }

  // Control plane (served by the Worker): authenticated by the session cookie.
  function request<A, I>(
    schema: Schema.Schema<A, I, never>,
    method: Method,
    path: string,
    body?: unknown
  ): Promise<A> {
    return send(schema, method, `${serverUrl}${path}`, cookieHeaders, body);
  }

  // Box-served paths: the relayed Kestrel box goes through the Worker with the session; a direct box takes a bearer token.
  async function boxRequest<A, I>(
    schema: Schema.Schema<A, I, never>,
    method: Method,
    path: string,
    body?: unknown
  ): Promise<A> {
    if (activeBox === null) return request(schema, method, path, body);
    const box = activeBox;
    const attempt = async () =>
      send(
        schema,
        method,
        `${box.url}${path}`,
        { Authorization: `Bearer ${(await mintBoxToken(box)).token}` },
        body
      );
    try {
      return await attempt();
    } catch (error) {
      // The box rejected the token (for example, its secret rotated): drop it and mint once more. This is not a sign-out.
      if (!(error instanceof ApiError) || error.status !== 401) throw error;
      boxToken = null;
      return attempt();
    }
  }

  /**
   * The box-level half of the connections list. A box too old to report capabilities (404) still reports CLI logins:
   * its native sign-ins stay usable while no harness is offered. Any other failure marks the whole box unavailable, so
   * a network error can never expose a harness the box did not confirm.
   */
  async function boxConnectionSource(): Promise<{
    cliAuth: readonly CliAuthStatus[] | undefined;
    harnesses: readonly ModelProvider[] | undefined;
    error?: string;
  }> {
    let cliAuth: readonly CliAuthStatus[];
    try {
      cliAuth = await boxRequest(Schema.Array(CliAuthStatus), "GET", ControlPaths.cliAuthFor(CliProvider.literals));
    } catch (error) {
      return {
        cliAuth: undefined,
        harnesses: undefined,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    try {
      const capabilities = await boxRequest(BoxCapabilities, "GET", Paths.capabilities);
      return { cliAuth, harnesses: capabilities.harnesses };
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return { cliAuth, harnesses: undefined };
      return {
        cliAuth: undefined,
        harnesses: undefined,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return {
    boxScope: JSON.stringify(activeBox === null ? [serverUrl, "relay"] : [serverUrl, "direct", activeBox.id, activeBox.url]),
    fileSource: async (path) => {
      if (activeBox === null) return { uri: serverUrl + path, headers: cookieHeaders };
      const { token } = await mintBoxToken(activeBox);
      return { uri: `${activeBox.url}${path}?${BOX_TOKEN_QUERY}=${encodeURIComponent(token)}`, headers: {} };
    },
    fileAccess: async () => {
      if (activeBox !== null) {
        const { token, expiresAt } = await mintBoxToken(activeBox);
        return { base: activeBox.url, query: `?${BOX_TOKEN_QUERY}=${encodeURIComponent(token)}`, expiresAt };
      }
      // The relayed Kestrel box: a WebView cannot send the session cookie, so the Worker accepts a file token instead.
      const minted = await mintFileToken();
      return {
        base: serverUrl,
        query: `?${BOX_TOKEN_QUERY}=${encodeURIComponent(minted.token)}`,
        expiresAt: Date.parse(minted.expiresAt),
      };
    },
    socketUrl: async (path) => {
      if (activeBox === null) return serverUrl.replace(/^http/, "ws") + path;
      const { token } = await mintBoxToken(activeBox);
      return `${activeBox.url.replace(/^http/, "ws")}${path}?${BOX_TOKEN_QUERY}=${encodeURIComponent(token)}`;
    },
    desktopSocketUrl: async (taskId, options) => {
      const path = Paths.taskDesktopWs(taskId);
      const box = activeBox;
      const { token } = box !== null ? await mintBoxToken(box, options?.fresh) : await mintDesktopToken(taskId, options?.fresh ?? false);
      const base = box !== null ? box.url : serverUrl;
      return `${base.replace(/^http/, "ws")}${path}?${BOX_TOKEN_QUERY}=${encodeURIComponent(token)}`;
    },
    desktopEmbedUrl: (taskId, ws) =>
      `${serverUrl}${DESKTOP_EMBED_PATH}#ws=${encodeURIComponent(ws)}&task=${encodeURIComponent(taskId)}`,
    previewFrameUrl: (taskId, token) => (activeBox?.url ?? serverUrl) + Paths.taskPreviewFrame(token, taskId),

    // Control plane (served by the Worker).
    me: () => request(Me, "GET", ControlPaths.me),
    logout: () => request(Schema.Unknown, "POST", ControlPaths.logout).then(() => undefined),
    connections: async () => {
      const stored = await request(Schema.Array(Connection), "GET", ControlPaths.connections);
      return connectionsForBox(stored, await boxConnectionSource());
    },
    putApiKey: (provider, body) => request(Connection, "PUT", ControlPaths.connection(provider), body),
    deleteConnection: (provider) =>
      request(Schema.Unknown, "DELETE", ControlPaths.connection(provider)).then(() => undefined),
    githubRepos: () => request(Schema.Array(GithubRepo), "GET", ControlPaths.githubRepos),
    githubBranches: (repo) => request(Schema.Array(Schema.String), "GET", ControlPaths.githubBranches(repo)),
    boxes: () => request(BoxList, "GET", ControlPaths.boxes),
    setActiveBox: (boxId) => request(BoxList, "PUT", ControlPaths.activeBox, { boxId }),
    box: async () => {
      if (activeBox === null) return request(BoxStatus, "GET", ControlPaths.box);
      // A direct box is reached at its own URL: its unauthenticated health route answers, and an unreachable box reads as offline.
      try {
        const health = await send(Health, "GET", `${activeBox.url}${Paths.health}`, {});
        return { online: true, connectedAt: null, boxVersion: health.version };
      } catch (error) {
        if (error instanceof ApiError && error.status >= 400 && error.status < 500) throw error;
        return { online: false, connectedAt: null, boxVersion: null };
      }
    },
    cliLoginStart: (provider) => boxRequest(CliLoginStart, "POST", ControlPaths.cliLogin(provider)),
    cliLoginCode: (provider, body) => boxRequest(CliAuthStatus, "POST", ControlPaths.cliLoginCode(provider), body),
    cliLoginKey: (provider, body) => boxRequest(CliAuthStatus, "POST", ControlPaths.cliLoginKey(provider), body),
    cliLogout: (provider) =>
      boxRequest(Schema.Unknown, "DELETE", ControlPaths.cliLogout(provider)).then(() => undefined),
    listAutomations: () => request(Schema.Array(Automation), "GET", ControlPaths.automations),
    createAutomation: (body) => request(Automation, "POST", ControlPaths.automations, body),
    updateAutomation: (id, body) => request(Automation, "PATCH", ControlPaths.automation(id), body),
    deleteAutomation: (id) => request(Schema.Unknown, "DELETE", ControlPaths.automation(id)).then(() => undefined),
    listAutomationRuns: (id) => request(Schema.Array(AutomationRun), "GET", ControlPaths.automationRuns(id)),
    triggerAutomation: (id, body) => request(AutomationRun, "POST", ControlPaths.automationTrigger(id), body),

    // Agent box (relayed by the Worker, or served directly by the user's own box).
    listTasks: () => boxRequest(Schema.Array(Task), "GET", Paths.tasks),
    createTask: (body) => boxRequest(Task, "POST", Paths.tasks, body),
    getTask: (taskId) => boxRequest(Task, "GET", Paths.task(taskId)),
    archiveTask: (taskId) => boxRequest(Task, "POST", Paths.taskArchive(taskId)),
    unarchiveTask: (taskId) => boxRequest(Task, "DELETE", Paths.taskArchive(taskId)),
    listMessages: (taskId) => boxRequest(Schema.Array(Message), "GET", Paths.taskMessages(taskId)),
    sendMessage: (taskId, body) => boxRequest(SendMessageResponse, "POST", Paths.taskMessages(taskId), body),
    listRuns: (taskId) => boxRequest(Schema.Array(Run), "GET", Paths.taskRuns(taskId)),
    runItems: (runId) => boxRequest(RunItems, "GET", Paths.runItems(runId)),
    cancelRun: (runId) => boxRequest(Run, "POST", Paths.runCancel(runId)),
    setUsageLimitAutoResume: (taskId, autoResume) =>
      boxRequest(Task, "PUT", Paths.taskUsageLimit(taskId), { autoResume }),
    getDiff: (taskId) => boxRequest(DiffResponse, "GET", Paths.taskDiff(taskId)),
    getDesktop: (taskId) => boxRequest(DesktopStatus, "GET", Paths.taskDesktop(taskId)),
    startDesktop: (taskId) => boxRequest(DesktopStatus, "POST", Paths.taskDesktop(taskId)),
    stopDesktop: (taskId) => boxRequest(Schema.Unknown, "DELETE", Paths.taskDesktop(taskId)).then(() => undefined),
    usage: () => boxRequest(Usage, "GET", Paths.usage),
    providerUsage: () => boxRequest(Schema.Array(ProviderUsage), "GET", ControlPaths.cliUsageFor(CliProvider.literals)),
    capabilities: () => boxRequest(BoxCapabilities, "GET", Paths.capabilities),
    textGenerationSettings: () => boxRequest(TextGenerationSettings, "GET", Paths.textGenerationSettings),
    saveTextGenerationSettings: (settings) =>
      boxRequest(TextGenerationSettings, "PUT", Paths.textGenerationSettings, settings),
    threadSettings: () => boxRequest(ThreadSettings, "GET", Paths.threadSettings),
    saveThreadSettings: (settings) => boxRequest(ThreadSettings, "PUT", Paths.threadSettings, settings),
    useBankedReset: (provider, body) =>
      boxRequest(UseBankedResetResult, "POST", ControlPaths.cliUseBankedReset(provider), body),
    usageActivity: () =>
      boxRequest(
        UsageActivity,
        "GET",
        `${Paths.usageActivity}?tz=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone)}`
      ),
    commands: (taskId: string, model: AgentModel) =>
      boxRequest(HarnessCommands, "GET", `${Paths.taskCommands(taskId)}?model=${encodeURIComponent(model)}`),
    previewSession: (taskId: string) => boxRequest(PreviewSession, "POST", Paths.taskPreviewSession(taskId)),
  };
}
