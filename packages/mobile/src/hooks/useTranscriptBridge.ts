import { useCallback, useEffect, useRef, useState } from "react";
import type { TranscriptDomRef } from "@/components/TranscriptDom";
import { diffTranscript, type TranscriptData, type TranscriptSnapshot } from "@/lib/transcriptBridge";

/**
 * Keeps `TranscriptDom` in step with `data`: a snapshot prop per epoch, then each change as a patch through the ref.
 * The DOM side asks for a new epoch (`resync`) when it mounts or misses a patch, so a patch sent before its WebView
 * loaded, or lost on the way, costs one snapshot instead of a stale transcript.
 */
export function useTranscriptBridge(data: TranscriptData) {
  const ref = useRef<TranscriptDomRef>(null);
  const latest = useRef(data);
  latest.current = data;
  const [snapshot, setSnapshot] = useState<TranscriptSnapshot>(() => ({ ...data, epoch: 0 }));
  // What the DOM side holds once it has applied everything sent: the snapshot plus `seq` patches.
  const sent = useRef({ epoch: 0, seq: 0, data });

  const resync = useCallback(() => {
    const epoch = sent.current.epoch + 1;
    sent.current = { epoch, seq: 0, data: latest.current };
    setSnapshot({ ...latest.current, epoch });
  }, []);

  useEffect(() => {
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
