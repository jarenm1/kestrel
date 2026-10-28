import { Schema } from "effect";
import {
  Automation,
  AutomationRun,
  BoxStatus,
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
  Me,
  Message,
  Paths,
  PutApiKeyBody,
  Run,
  SendMessageBody,
  SendMessageResponse,
  Task,
  TriggerAutomationBody,
  UpdateAutomationBody,
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

/** Image source for an attachment; it needs the session cookie, so it is passed as a request header. */
export interface AttachmentSource {
  uri: string;
  headers: Record<string, string>;
}

/** Typed client for the control plane and the agent box, bound to one server URL and session. */
export interface ApiClient {
  serverUrl: string;
  attachmentSource(taskId: string, attachmentId: string): AttachmentSource;

  me(): Promise<Me>;
  logout(): Promise<void>;
  connections(): Promise<readonly Connection[]>;
  putApiKey(provider: string, body: PutApiKeyBody): Promise<Connection>;
  deleteConnection(provider: string): Promise<void>;
  githubRepos(): Promise<readonly GithubRepo[]>;
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
  cancelRun(runId: string): Promise<Run>;
  getDiff(taskId: string): Promise<DiffResponse>;
  getDesktop(taskId: string): Promise<DesktopStatus>;
  startDesktop(taskId: string): Promise<DesktopStatus>;
  stopDesktop(taskId: string): Promise<void>;
}

/** Creates an API client bound to one server URL and session cookie. Responses are decoded with protocol schemas. */
export function createApiClient(serverUrl: string, sessionCookie: string | null): ApiClient {
  const cookieHeaders: Record<string, string> = sessionCookie ? { Cookie: `session=${sessionCookie}` } : {};

  async function request<A, I>(
    schema: Schema.Schema<A, I, never>,
    method: Method,
    path: string,
    body?: unknown
  ): Promise<A> {
    const headers: Record<string, string> = { ...cookieHeaders };
    if (body !== undefined) headers["Content-Type"] = "application/json";

    let res: Response;
    try {
      res = await fetch(`${serverUrl}${path}`, {
        method,
        headers,
        credentials: "include",
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new ApiError(0, `Cannot reach server at ${serverUrl}: ${String(e)}`);
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

  return {
    serverUrl,
    attachmentSource: (taskId, attachmentId) => ({
      uri: serverUrl + Paths.taskAttachment(taskId, attachmentId),
      headers: cookieHeaders,
    }),

    // Control plane (served by the Worker).
    me: () => request(Me, "GET", ControlPaths.me),
    logout: () => request(Schema.Unknown, "POST", ControlPaths.logout).then(() => undefined),
    connections: () => request(Schema.Array(Connection), "GET", ControlPaths.connections),
    putApiKey: (provider, body) => request(Connection, "PUT", ControlPaths.connection(provider), body),
    deleteConnection: (provider) =>
      request(Schema.Unknown, "DELETE", ControlPaths.connection(provider)).then(() => undefined),
    githubRepos: () => request(Schema.Array(GithubRepo), "GET", ControlPaths.githubRepos),
    box: () => request(BoxStatus, "GET", ControlPaths.box),
    cliLoginStart: (provider) => request(CliLoginStart, "POST", ControlPaths.cliLogin(provider)),
    cliLoginCode: (provider, body) => request(CliAuthStatus, "POST", ControlPaths.cliLoginCode(provider), body),
    cliLogout: (provider) =>
      request(Schema.Unknown, "DELETE", ControlPaths.cliLogout(provider)).then(() => undefined),
    listAutomations: () => request(Schema.Array(Automation), "GET", ControlPaths.automations),
    createAutomation: (body) => request(Automation, "POST", ControlPaths.automations, body),
    updateAutomation: (id, body) => request(Automation, "PATCH", ControlPaths.automation(id), body),
    deleteAutomation: (id) => request(Schema.Unknown, "DELETE", ControlPaths.automation(id)).then(() => undefined),
    listAutomationRuns: (id) => request(Schema.Array(AutomationRun), "GET", ControlPaths.automationRuns(id)),
    triggerAutomation: (id, body) => request(AutomationRun, "POST", ControlPaths.automationTrigger(id), body),

    // Agent box (relayed by the Worker).
    listTasks: () => request(Schema.Array(Task), "GET", Paths.tasks),
    createTask: (body) => request(Task, "POST", Paths.tasks, body),
    getTask: (taskId) => request(Task, "GET", Paths.task(taskId)),
    archiveTask: (taskId) => request(Task, "POST", Paths.taskArchive(taskId)),
    unarchiveTask: (taskId) => request(Task, "DELETE", Paths.taskArchive(taskId)),
    listMessages: (taskId) => request(Schema.Array(Message), "GET", Paths.taskMessages(taskId)),
    sendMessage: (taskId, body) => request(SendMessageResponse, "POST", Paths.taskMessages(taskId), body),
    listRuns: (taskId) => request(Schema.Array(Run), "GET", Paths.taskRuns(taskId)),
    cancelRun: (runId) => request(Run, "POST", Paths.runCancel(runId)),
    getDiff: (taskId) => request(DiffResponse, "GET", Paths.taskDiff(taskId)),
    getDesktop: (taskId) => request(DesktopStatus, "GET", Paths.taskDesktop(taskId)),
    startDesktop: (taskId) => request(DesktopStatus, "POST", Paths.taskDesktop(taskId)),
    stopDesktop: (taskId) => request(Schema.Unknown, "DELETE", Paths.taskDesktop(taskId)).then(() => undefined),
  };
}
