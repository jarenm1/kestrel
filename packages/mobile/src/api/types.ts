/**
 * TypeScript types mirroring @cloudagents/protocol for the mobile app.
 * These are plain interfaces (no Effect dependency) matching the JSON shapes
 * returned by the API. Kept in sync manually with packages/protocol.
 */

// Domain
export type TaskStatus = "idle" | "running" | "needs_input" | "done" | "failed";
export type RunStatus = "running" | "succeeded" | "failed" | "cancelled";
export type DesktopState = "stopped" | "starting" | "running" | "failed";
export type ConnectionKind = "oauth" | "apikey" | "cli";
export type CliProvider = "claude-cli" | "codex-cli";

export interface Repo {
  id: string;
  name: string;
  url: string;
  localPath: string;
  defaultBranch: string;
  createdAt: string;
  owner: string;
}

export interface Task {
  id: string;
  repoId: string;
  title: string;
  branch: string;
  baseBranch: string;
  worktreePath: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  taskId: string;
  role: "user" | "agent" | "system";
  text: string;
  runId: string | null;
  createdAt: string;
}

export interface Run {
  id: string;
  taskId: string;
  prompt: string;
  status: RunStatus;
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
}

export interface DesktopStatus {
  taskId: string;
  state: DesktopState;
  display: string | null;
  width: number;
  height: number;
  fps: number;
  mime: string | null;
  error: string | null;
}

export interface Me {
  login: string;
  name: string | null;
  avatarUrl: string;
}

export interface Connection {
  provider: string;
  label: string;
  kind: ConnectionKind;
  connected: boolean;
  account: string | null;
  available: boolean;
}

export interface BoxStatus {
  online: boolean;
  connectedAt: string | null;
  boxVersion: string | null;
}

export interface GithubRepo {
  fullName: string;
  cloneUrl: string;
  private: boolean;
  defaultBranch: string;
  updatedAt: string;
}

export interface SendMessageResponse {
  message: Message;
  run: Run;
}

export interface DiffResponse {
  baseBranch: string;
  diff: string;
}

export interface CliLoginStart {
  provider: CliProvider;
  url: string;
  userCode: string | null;
  needsCode: boolean;
  expiresAt: string;
}

export interface CliAuthStatus {
  provider: CliProvider;
  loggedIn: boolean;
  account: string | null;
}

// Server events (over WebSocket)
export type ServerEvent =
  | { _tag: "task.updated"; task: Task }
  | { _tag: "message.created"; message: Message }
  | { _tag: "run.updated"; run: Run }
  | { _tag: "agent.output"; taskId: string; runId: string; stream: "stdout" | "stderr" | "event"; text: string }
  | { _tag: "desktop.updated"; desktop: DesktopStatus };

// REST paths — kept in sync with packages/protocol
export const Paths = {
  health: "/api/health",
  repos: "/api/repos",
  repo: (id: string) => `/api/repos/${id}`,
  repoTasks: (repoId: string) => `/api/repos/${repoId}/tasks`,
  task: (id: string) => `/api/tasks/${id}`,
  taskMessages: (id: string) => `/api/tasks/${id}/messages`,
  taskRuns: (id: string) => `/api/tasks/${id}/runs`,
  taskDiff: (id: string) => `/api/tasks/${id}/diff`,
  taskDesktop: (id: string) => `/api/tasks/${id}/desktop`,
  runCancel: (id: string) => `/api/runs/${id}/cancel`,
  taskEventsWs: (id: string) => `/api/tasks/${id}/events`,
  taskDesktopWs: (id: string) => `/api/tasks/${id}/desktop/stream`,
} as const;

export const ControlPaths = {
  login: "/auth/github/login",
  logout: "/auth/logout",
  me: "/api/me",
  connections: "/api/connections",
  connection: (provider: string) => `/api/connections/${provider}`,
  githubRepos: "/api/github/repos",
  box: "/api/box",
  connectOAuth: (provider: string) => `/auth/connect/${provider}`,
  cliLogin: (provider: CliProvider) => `/api/cli-auth/${provider}/login`,
  cliLoginCode: (provider: CliProvider) => `/api/cli-auth/${provider}/code`,
  cliLogout: (provider: CliProvider) => `/api/cli-auth/${provider}`,
} as const;

