import React, { useEffect, useState } from "react";
import { Image, type ImageStyle, type StyleProp, View } from "react-native";
import { Paths } from "@cloudagents/protocol";
import type { FileSource } from "@/api/client";
import { useApiClient } from "@/hooks/useApiClient";

/**
 * A task attachment, contained in its frame. The source resolves asynchronously (the user's own box needs a minted token),
 * so the frame stays empty until it resolves.
 */
export function AttachmentImage({
  taskId,
  attachmentId,
  style,
  accessibilityLabel,
}: {
  taskId: string;
  attachmentId: string;
  style: StyleProp<ImageStyle>;
  accessibilityLabel: string;
}) {
  const { api } = useApiClient();
  const [source, setSource] = useState<FileSource | null>(null);

  useEffect(() => {
    let active = true;
    setSource(null);
    // A failed token mint leaves the frame empty; the box queries report the same failure.
    api
      .fileSource(Paths.taskAttachment(taskId, attachmentId))
      .then((resolved) => {
        if (active) setSource(resolved);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [api, taskId, attachmentId]);

  if (source === null) {
    return <View style={style} accessibilityLabel={accessibilityLabel} />;
  }
  return (
    <Image
      source={source}
      style={style}
      resizeMode="contain"
      accessibilityLabel={accessibilityLabel}
    />
  );
}
