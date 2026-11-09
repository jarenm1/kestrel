import { useMemo } from "react";
import type { ManagedBox, UserBox } from "@cloudagents/protocol";
import { createApiClient, type ActiveBox, type ApiClient } from "@/api/client";
import { useAuth } from "@/auth/AuthContext";

/** Kestrel's managed box, whether the app reaches it directly or through the control plane's relay. */
const KESTREL_BOX = "Kestrel's box";

/** A box whose threads the sidebar lists: its route (`null` for the relayed Kestrel box), its name and its client. */
export interface BoxSource {
  label: string;
  box: ActiveBox | null;
  api: ApiClient;
}

/** The name a box route shows: the managed (or relayed) box is Kestrel's; a user's own box shows its name. */
export function boxLabel(box: ActiveBox | null, boxes: readonly UserBox[], managedBox: ManagedBox | null): string {
  if (box === null || box.id === managedBox?.id) return KESTREL_BOX;
  return boxes.find((b) => b.id === box.id)?.name ?? "Box";
}

/**
 * Every box whose threads the sidebar lists: Kestrel's managed box, each of the user's own boxes, and the relayed
 * Kestrel box when neither a chosen box nor an assigned one applies.
 */
export function useBoxSources(): BoxSource[] {
  const { serverUrl, sessionCookie, sessionEpoch, boxes, managedBox, activeBox } = useAuth();
  return useMemo(() => {
    const url = serverUrl ?? "";
    const source = (label: string, box: ActiveBox | null): BoxSource => ({
      label,
      box,
      api: createApiClient(url, sessionCookie, box, sessionEpoch),
    });
    const sources: BoxSource[] = [];
    if (managedBox !== null) sources.push(source(KESTREL_BOX, { id: managedBox.id, url: managedBox.url }));
    for (const box of boxes) {
      if (box.id !== managedBox?.id) sources.push(source(box.name, { id: box.id, url: box.url }));
    }
    if (activeBox === null && managedBox === null) sources.push(source(KESTREL_BOX, null));
    return sources;
  }, [serverUrl, sessionCookie, sessionEpoch, boxes, managedBox, activeBox]);
}
