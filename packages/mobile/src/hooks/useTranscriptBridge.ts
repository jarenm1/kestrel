import { useCallback, useEffect, useRef, useState } from "react";
import type { TranscriptDomRef } from "@/components/TranscriptDom";
import { diffTranscript, type TranscriptData, type TranscriptSnapshot } from "@/lib/transcriptBridge";

/**
 * Keeps `TranscriptDom` in step with `data`: a snapshot prop per epoch, then each change as a patch through the ref.
 * The DOM side asks for a new epoch (`resync`) when it mounts or misses a patch, so a patch lost on the way costs one
 * snapshot instead of a stale transcript. Nothing is patched before that first request: in the native WebView the
 * ref has no `patch` method until the DOM side has loaded and registered it, and the snapshot covers the gap.
 */
export function useTranscriptBridge(data: TranscriptData) {
  const ref = useRef<TranscriptDomRef>(null);
  const latest = useRef(data);
  latest.current = data;
  const [snapshot, setSnapshot] = useState<TranscriptSnapshot>(() => ({ ...data, epoch: 0 }));
  // What the DOM side holds once it has applied everything sent: the snapshot plus `seq` patches.
  const sent = useRef({ epoch: 0, seq: 0, data });
  const ready = useRef(false);

  const resync = useCallback(() => {
    ready.current = true;
    const epoch = sent.current.epoch + 1;
    sent.current = { epoch, seq: 0, data: latest.current };
    setSnapshot({ ...latest.current, epoch });
  }, []);

  useEffect(() => {
    if (!ready.current) return;
    if (data.taskId !== sent.current.data.taskId) {
      resync();
      return;
    }
    const changes = diffTranscript(sent.current.data, data);
    if (changes === null) return;
    const { epoch } = sent.current;
    const seq = sent.current.seq + 1;
    sent.current = { epoch, seq, data };
    ref.current?.patch({ ...changes, epoch, seq });
  });

  return { ref, snapshot, resync };
}
