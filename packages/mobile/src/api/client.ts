import { Schema } from "effect";
import {
  AgentModel,
  Automation,
  AutomationRun,
  BOX_TOKEN_QUERY,
  BoxList,
  BoxStatus,
  BoxToken,
  CliAuthStatus,
  CliLoginCodeBody,
  CliLoginStart,
  CliProvider,
  Connection,
  ControlPaths,
  CreateAutomationBody,
  CreateTaskBody,
  DesktopStatus,
  DiffResponse,
  GithubRepo,
  Health,
  HarnessCommands,
  Me,
  Message,
  Paths,
  PreviewSession,
  PutApiKeyBody,
  Run,
  RunItems,
  SendMessageBody,
  SendMessageResponse,
  Task,
  TriggerAutomationBody,
  UpdateAutomationBody,
  Usage,
  type UserBox,
} from "@cloudagents/protocol";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

function errorMessage(text: string, fallback: string): string {
  try {
    const body: unknown = JSON.parse(text);
    if (typeof body === "object" && body !== null && "message" in body && typeof body.message === "string") {
      return body.message;
    }
  } catch {
    // Not JSON; fall through to the raw text.
  }
  return text || fallback;
}

/** The user's own box that their apps use; `null` everywhere means Kestrel's box, relayed by the Worker. */
export type ActiveBox = Pick<UserBox, "id" | "url">;

/** Image source for a box file; it needs the session cookie, or the box token, so it is passed as request headers or a query. */
export interface FileSource {
  uri: string;
  headers: Record<string, string>;
}

/** A minted box token is replaced this long before the box says it expires. */
const TOKEN_REFRESH_MARGIN_MS = 60_000;

/** Typed client for the control plane and the agent box, bound to one server URL, session and active box. */
export interface ApiClient {
  /** Source of a file the box serves (`Paths.taskAttachment`, `Paths.taskCheckoutIcon`). */
  fileSource(path: string): Promise<FileSource>;
  /** A WebSocket URL for a box path (`Paths.*Ws`), carrying the box token when the active box is the user's own. */
  socketUrl(path: string): Promise<string>;
  /** The sandboxed preview frame URL for a preview session token minted by `previewSession`. */
  previewFrameUrl(taskId: string, token: string): string;

  me(): Promise<Me>;
  logout(): Promise<void>;
  connections(): Promise<readonly Connection[]>;
  putApiKey(provider: string, body: PutApiKeyBody): Promise<Connection>;
  deleteConnection(provider: string): Promise<void>;
  githubRepos(): Promise<readonly GithubRepo[]>;
  boxes(): Promise<BoxList>;
  setActiveBox(boxId: string | null): Promise<BoxList>;
  box(): Promise<BoxStatus>;
  cliLoginStart(provider: CliProvider): Promise<CliLoginStart>;
  cliLoginCode(provider: CliProvider, body: CliLoginCodeBody): Promise<CliAuthStatus>;
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
  getDiff(taskId: string): Promise<DiffResponse>;
  getDesktop(taskId: string): Promise<DesktopStatus>;
  startDesktop(taskId: string): Promise<DesktopStatus>;
  stopDesktop(taskId: string): Promise<void>;
  usage(): Promise<Usage>;
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
      // RN's cookie jar would append a second session to our explicit Cookie header.
      credentials: "omit",
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new ApiError(0, `Cannot reach server at ${new URL(url).origin}: ${String(e)}`);
  }

  const text = await res.text();
  if (!res.ok) throw new ApiError(res.status, errorMessage(text, res.statusText));

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

/** Creates an API client bound to one server URL, session cookie and active box (`null` for Kestrel's box). */
export function createApiClient(
  serverUrl: string,
  sessionCookie: string | null,
  activeBox: ActiveBox | null
): ApiClient {
  const cookieHeaders: Record<string, string> = sessionCookie ? { Cookie: `session=${sessionCookie}` } : {};

  // The user's box token, single-flight: concurrent callers share one mint, and a failed mint is not kept.
  let boxToken: { token: Promise<string>; refreshAt: number } | null = null;
  function mintBoxToken(box: ActiveBox): Promise<string> {
    if (boxToken && Date.now() < boxToken.refreshAt) return boxToken.token;
    const entry: { token: Promise<string>; refreshAt: number } = {
      refreshAt: Number.POSITIVE_INFINITY,
      token: request(BoxToken, "POST", ControlPaths.userBoxToken(box.id)).then(
        (minted) => {
          entry.refreshAt = Date.parse(minted.expiresAt) - TOKEN_REFRESH_MARGIN_MS;
          return minted.token;
        },
        (error: unknown) => {
          if (boxToken === entry) boxToken = null;
          throw error;
        }
      ),
    };
    boxToken = entry;
    return entry.token;
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

  // Box-served paths: Kestrel's box is relayed through the Worker with the session; the user's own box takes a bearer token.
  async function boxRequest<A, I>(
    schema: Schema.Schema<A, I, never>,
    method: Method,
    path: string,
    body?: unknown
  ): Promise<A> {
    if (activeBox === null) return request(schema, method, path, body);
    const box = activeBox;
    const attempt = async () =>
      send(schema, method, `${box.url}${path}`, { Authorization: `Bearer ${await mintBoxToken(box)}` }, body);
    try {
      return await attempt();
    } catch (error) {
      // The box rejected the token (for example, its secret rotated): drop it and mint once more. This is not a sign-out.
      if (!(error instanceof ApiError) || error.status !== 401) throw error;
      boxToken = null;
      return attempt();
    }
  }

  return {
    fileSource: async (path) => {
      if (activeBox === null) return { uri: serverUrl + path, headers: cookieHeaders };
      const token = await mintBoxToken(activeBox);
      return { uri: `${activeBox.url}${path}?${BOX_TOKEN_QUERY}=${encodeURIComponent(token)}`, headers: {} };
    },
    socketUrl: async (path) => {
      if (activeBox === null) return serverUrl.replace(/^http/, "ws") + path;
      const token = await mintBoxToken(activeBox);
      return `${activeBox.url.replace(/^http/, "ws")}${path}?${BOX_TOKEN_QUERY}=${encodeURIComponent(token)}`;
    },
    previewFrameUrl: (taskId, token) => (activeBox?.url ?? serverUrl) + Paths.taskPreviewFrame(token, taskId),

    // Control plane (served by the Worker).
    me: () => request(Me, "GET", ControlPaths.me),
    logout: () => request(Schema.Unknown, "POST", ControlPaths.logout).then(() => undefined),
    connections: () => request(Schema.Array(Connection), "GET", ControlPaths.connections),
    putApiKey: (provider, body) => request(Connection, "PUT", ControlPaths.connection(provider), body),
    deleteConnection: (provider) =>
      request(Schema.Unknown, "DELETE", ControlPaths.connection(provider)).then(() => undefined),
    githubRepos: () => request(Schema.Array(GithubRepo), "GET", ControlPaths.githubRepos),
    boxes: () => request(BoxList, "GET", ControlPaths.boxes),
    setActiveBox: (boxId) => request(BoxList, "PUT", ControlPaths.activeBox, { boxId }),
    box: async () => {
      if (activeBox === null) return request(BoxStatus, "GET", ControlPaths.box);
      // The user's box is reached directly: its unauthenticated health route answers, and an unreachable box reads as offline.
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
    getDiff: (taskId) => boxRequest(DiffResponse, "GET", Paths.taskDiff(taskId)),
    getDesktop: (taskId) => boxRequest(DesktopStatus, "GET", Paths.taskDesktop(taskId)),
    startDesktop: (taskId) => boxRequest(DesktopStatus, "POST", Paths.taskDesktop(taskId)),
    stopDesktop: (taskId) => boxRequest(Schema.Unknown, "DELETE", Paths.taskDesktop(taskId)).then(() => undefined),
    usage: () => boxRequest(Usage, "GET", Paths.usage),
    commands: (taskId: string, model: AgentModel) =>
      boxRequest(HarnessCommands, "GET", `${Paths.taskCommands(taskId)}?model=${encodeURIComponent(model)}`),
    previewSession: (taskId: string) => boxRequest(PreviewSession, "POST", Paths.taskPreviewSession(taskId)),
  };
}
