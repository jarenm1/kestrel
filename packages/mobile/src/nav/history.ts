import { BackHandler } from "react-native";
import type { LaunchRoute, Route } from "@/nav/navigation";

/**
 * Platform glue for MainNavigator's in-memory stack. Native: Android's back button; there is no address bar. The web
 * build uses `history.web.ts`, which maps the browser's back button and URL onto the same stack.
 */

/** Runs `handler` on a back press; it returns true when it handled the press. Returns the unsubscribe. */
export function onBackPress(handler: () => boolean): () => void {
  const sub = BackHandler.addEventListener("hardwareBackPress", handler);
  return () => sub.remove();
}

/** The screen the app was opened on (a thread link), taken once after sign-in; `null` opens home. */
export function takeLaunchRoute(): LaunchRoute | null {
  return null;
}

/** Reflects the screen on top of the stack where the platform shows a location. */
export function showRoute(_route: Route): void {}
