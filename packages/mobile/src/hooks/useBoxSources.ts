import { useMemo } from "react";
import type { UserBox } from "@cloudagents/protocol";
import { createApiClient, type ActiveBox, type ApiClient } from "@/api/client";
import { useAuth } from "@/auth/AuthContext";

/** A box with no named route: the active box when the user has not picked one yet. */
const KESTREL_BOX = "Kestrel's box";

/** A box whose threads the sidebar lists: its route, its name and its client. */
export interface BoxSource {
  label: string;
  box: ActiveBox | null;
  api: ApiClient;
}

/** The name a box route shows: a named box shows its own name. */
export function boxLabel(box: ActiveBox | null, boxes: readonly UserBox[]): string {
  if (box === null) return KESTREL_BOX;
  return boxes.find((b) => b.id === box.id)?.name ?? "Box";
}

/** Every box whose threads the sidebar lists, plus an entry for the not-yet-provisioned active box. */
export function useBoxSources(): BoxSource[] {
  const { serverUrl, sessionCookie, boxes, activeBox } = useAuth();
  return useMemo(() => {
    const url = serverUrl ?? "";
    const source = (label: string, box: ActiveBox | null): BoxSource => ({
      label,
      box,
      api: createApiClient(url, sessionCookie, box),
    });
    const sources: BoxSource[] = boxes.map((box) => source(box.name, { id: box.id, url: box.url }));
    if (activeBox === null && boxes.length === 0) sources.push(source(KESTREL_BOX, null));
    return sources;
  }, [serverUrl, sessionCookie, boxes, activeBox]);
}
