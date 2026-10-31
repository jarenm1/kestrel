import { useEffect, useState } from "react";
import { AppState } from "react-native";

/** Whether the app is in the foreground. Streams that should not run in the background gate on it. */
export function useAppActive(): boolean {
  const [active, setActive] = useState(AppState.currentState === "active");

  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => setActive(state === "active"));
    return () => sub.remove();
  }, []);

  return active;
}
