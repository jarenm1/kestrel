import { createContext, useContext } from "react";

/** Every screen the signed-in app can show. The stack lives in MainNavigator. */
export type Route =
  | { name: "threads" }
  | { name: "new-thread" }
  | { name: "thread"; taskId: string }
  | { name: "archived" }
  | { name: "automations" }
  | { name: "connections" };

export interface Navigation {
  /** Pushes a screen on top of the stack. */
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
