/** Messages the desktop embed page (`<app host>/embed/desktop`) posts to the host. */
export type EmbedEvent = { readonly event: "status"; readonly state: string } | { readonly event: "auth-expired" } | { readonly event: "unreachable" };

/** Parses one `postMessage` payload from the embed; anything else is ignored. */
export function embedEvent(data: unknown): EmbedEvent | null {
  if (typeof data !== "object" || data === null) return null;
  const message = data as { type?: unknown; event?: unknown; state?: unknown };
  if (message.type !== "kestrel-desktop") return null;
  if (message.event === "auth-expired") return { event: "auth-expired" };
  if (message.event === "unreachable") return { event: "unreachable" };
  if (message.event === "status" && typeof message.state === "string") {
    return { event: "status", state: message.state };
  }
  return null;
}

/**
 * What the viewer derives from the embed. `unreachable` is a transport path the embed keeps retrying; `error` is a
 * terminal sign-in or URL-mint failure. They are separate so an unreachable box never reads as an expired sign-in.
 * The whole view is dropped when the embed URL changes: a new stream cannot inherit the old one's status.
 */
export interface ViewerView {
  readonly state: string | null;
  readonly unreachable: boolean;
  readonly error: string | null;
}

export const initialViewerView: ViewerView = { state: null, unreachable: false, error: null };

export type ViewerAction =
  | { readonly _tag: "embedChanged" }
  | { readonly _tag: "message"; readonly message: EmbedEvent }
  | { readonly _tag: "failed"; readonly reason: string };

export const reduceViewer = (viewer: ViewerView, action: ViewerAction): ViewerView => {
  switch (action._tag) {
    case "embedChanged":
      return initialViewerView;
    case "failed":
      return { ...viewer, state: null, unreachable: false, error: action.reason };
    case "message":
      switch (action.message.event) {
        case "status":
          return { state: action.message.state, unreachable: false, error: null };
        case "unreachable":
          return { ...viewer, state: null, unreachable: true };
        case "auth-expired":
          return { ...viewer, state: null, unreachable: false };
      }
  }
};
