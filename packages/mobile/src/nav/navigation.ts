import { createContext, useContext } from "react";

/** Every screen the signed-in app can show. The stack lives in MainNavigator. */
export type Route =
  | { name: "new-thread" }
  | { name: "thread"; taskId: string }
  | { name: "archived" }
  | { name: "automations" }
  | { name: "connections" };

export interface Navigation {
  /** The route on screen. */
  current: Route;
  /** Opens a screen from the thread sidebar: the history becomes home plus that screen, so back returns home. */
  navigate(route: Route): void;
  /** Pushes a screen on top of the stack (a link inside a page, e.g. an archived thread). */
  push(route: Route): void;
  /** Replaces the top screen (used after creating a thread from the composer). */
  replace(route: Route): void;
  /** Pops the top screen; no-op at the root. */
  back(): void;
}

export const NavigationContext = createContext<Navigation | null>(null);

export function useNavigation(): Navigation {
  const nav = useContext(NavigationContext);
  if (!nav) throw new Error("useNavigation must be used inside MainNavigator");
  return nav;
}

/** The workspace shell around every screen: the swipeable thread sidebar. */
export interface Shell {
  openSidebar(): void;
  /**
   * While set, the sidebar does not follow swipes. A screen with its own horizontal swipe target (the thread's
   * Desktop/Diff panel) locks it while that panel is open, so a right swipe closes the panel instead.
   */
  lockSidebarSwipe(locked: boolean): void;
  /**
   * Lets the screen claim Android back before it pops the screen (the open Desktop/Diff panel closes first).
   * The handler returns true when it handled the press; pass null to remove it.
   */
  interceptBack(handler: (() => boolean) | null): void;
}

export const ShellContext = createContext<Shell | null>(null);

export function useShell(): Shell {
  const shell = useContext(ShellContext);
  if (!shell) throw new Error("useShell must be used inside MainNavigator");
  return shell;
}
