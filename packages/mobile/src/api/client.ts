import { useAuth } from "@/auth/AuthContext";
import type {
  BoxStatus,
  Connection,
  GithubRepo,
  Me,
  Message,
  Repo,
  Run,
  SendMessageResponse,
  Task,
  DesktopStatus,
  DiffResponse,
  CliLoginStart,
  CliAuthStatus,
  CliProvider,
} from "@/api/types";
import { ControlPaths, Paths } from "@/api/types";

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

type RequestMethod = "GET" | "POST" | "PUT" | "DELETE";

/** Creates an API client bound to the current server URL and session. */
export function createApiClient(serverUrl: string, sessionCookie: string | null) {
  async function request<T>(method: RequestMethod, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (sessionCookie) {
      headers["Cookie"] = `session=${sessionCookie}`;
    }
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    const res = await fetch(`${serverUrl}${path}`, {
      method,
      headers,
      credentials: "include",
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();

    if (!res.ok) {
      let msg: string;
      try {
        const parsed = JSON.parse(text);
        msg = typeof parsed?.message === "string" ? parsed.message : text || res.statusText;
      } catch {
        msg = text || res.statusText;
      }
      throw new ApiError(res.status, msg);
    }

    if (text === "") return undefined as T;
    return JSON.parse(text) as T;
  }

  return {
    // Control plane
    me: () => request<Me>("GET", ControlPaths.me),
    logout: () => request<void>("POST", ControlPaths.logout),
    connections: () => request<Connection[]>("GET", ControlPaths.connections),
    putApiKey: (provider: string, body: { apiKey: string }) =>
      request<Connection>("PUT", ControlPaths.connection(provider), body),
    deleteConnection: (provider: string) =>
      request<void>("DELETE", ControlPaths.connection(provider)),
    githubRepos: () => request<GithubRepo[]>("GET", ControlPaths.githubRepos),
    box: () => request<BoxStatus>("GET", ControlPaths.box),
    cliLoginStart: (provider: CliProvider) =>
      request<CliLoginStart>("POST", ControlPaths.cliLogin(provider)),
    cliLoginCode: (provider: CliProvider, body: { code: string }) =>
      request<CliAuthStatus>("POST", ControlPaths.cliLoginCode(provider), body),
    cliLogout: (provider: CliProvider) =>
      request<void>("DELETE", ControlPaths.cliLogout(provider)),

    // Agent box (relayed)
    listRepos: () => request<Repo[]>("GET", Paths.repos),
    addRepo: (body: { url: string; name?: string }) =>
      request<Repo>("POST", Paths.repos, body),
    getRepo: (repoId: string) => request<Repo>("GET", Paths.repo(repoId)),
    listRepoTasks: (repoId: string) =>
      request<Task[]>("GET", Paths.repoTasks(repoId)),
    createTask: (repoId: string, body: { title?: string; baseBranch?: string }) =>
      request<Task>("POST", Paths.repoTasks(repoId), body),
    getTask: (taskId: string) => request<Task>("GET", Paths.task(taskId)),
    listMessages: (taskId: string) =>
      request<Message[]>("GET", Paths.taskMessages(taskId)),
    sendMessage: (taskId: string, text: string) =>
      request<SendMessageResponse>("POST", Paths.taskMessages(taskId), { text }),
    listRuns: (taskId: string) => request<Run[]>("GET", Paths.taskRuns(taskId)),
    cancelRun: (runId: string) => request<Run>("POST", Paths.runCancel(runId)),
    getDiff: (taskId: string) =>
      request<DiffResponse>("GET", Paths.taskDiff(taskId)),
    getDesktop: (taskId: string) =>
      request<DesktopStatus>("GET", Paths.taskDesktop(taskId)),
    startDesktop: (taskId: string) =>
      request<DesktopStatus>("POST", Paths.taskDesktop(taskId)),
    stopDesktop: (taskId: string) =>
      request<void>("DELETE", Paths.taskDesktop(taskId)),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;

