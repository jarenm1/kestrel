import type { LaunchRoute, Route, SettingsSection } from "@/nav/navigation";

/**
 * The web build's navigation glue. The stack stays in memory; the browser sees one extra "back" history entry while a
 * back press can be handled in the app, so the phone's back gesture closes the sidebar or pops a screen instead of
 * leaving the page. URLs follow the web app's (`/c/:id`, `/automations`, `/archived`, `/settings/...`) so reloads and
 * shared links land on the same screen. The Worker serves this build for exactly these paths (MOBILE_PAGE).
 */

const THREAD_PATH = /^\/c\/([^/]+)$/;

/**
 * The web app's URL for each settings page. `Record<SettingsSection, string>`: adding a section to the route type
 * makes this map and `pathFor` fail to compile until its URL is here too.
 */
const SECTION_PATHS: Record<SettingsSection, string> = {
  profile: "/settings/profile",
  threads: "/settings/threads",
  boxes: "/settings/boxes",
  billing: "/settings/billing",
};

/** The section whose web URL this path is, if any. */
function sectionOf(path: string): SettingsSection | null {
  return (
    (Object.entries(SECTION_PATHS) as [SettingsSection, string][]).find(([, sectionPath]) => sectionPath === path)?.[0] ??
    null
  );
}

let handler: (() => boolean) | null = null;
/** Whether the extra history entry is on top, so the next browser back is ours to handle. */
let armed = false;
let listening = false;
/** The path of the screen on top; the extra entry is pushed with it, since the entry under it keeps an older URL. */
let shownPath = window.location.pathname;
let launch: LaunchRoute | null = launchRoute();

function launchRoute(): LaunchRoute | null {
  const path = window.location.pathname.replace(/(.)\/$/, "$1");
  const thread = THREAD_PATH.exec(path);
  if (thread?.[1]) return { name: "thread", taskId: decodeURIComponent(thread[1]) };
  if (path === "/automations") return { name: "automations" };
  if (path === "/archived") return { name: "archived" };
  if (path === "/settings/connections") return { name: "connections" };
  if (path === "/settings/usage") return { name: "usage" };
  const section = sectionOf(path);
  if (section !== null) return { name: "settings", section };
  if (path === "/settings" || path.startsWith("/settings/")) return { name: "settings" };
  return null;
}

function pathFor(route: Route): string {
  switch (route.name) {
    case "thread":
      return `/c/${encodeURIComponent(route.taskId)}`;
    case "automations":
      return "/automations";
    case "archived":
      return "/archived";
    case "connections":
      return "/settings/connections";
    case "settings":
      return route.section === undefined ? "/settings" : SECTION_PATHS[route.section];
    case "usage":
      return "/settings/usage";
    case "new-thread":
      return "/";
  }
}

function arm() {
  if (armed) return;
  armed = true;
  window.history.pushState({ kestrelBack: true }, "", shownPath);
}

function onPopState() {
  armed = false;
  if (handler?.()) arm();
  else window.history.back();
}

export function onBackPress(next: () => boolean): () => void {
  if (!listening) {
    listening = true;
    window.addEventListener("popstate", onPopState);
  }
  handler = next;
  arm();
  return () => {
    if (handler === next) handler = null;
  };
}

export function takeLaunchRoute(): LaunchRoute | null {
  const route = launch;
  launch = null;
  return route;
}

export function showRoute(route: Route): void {
  shownPath = pathFor(route);
  if (window.location.pathname !== shownPath) window.history.replaceState(window.history.state, "", shownPath);
}
