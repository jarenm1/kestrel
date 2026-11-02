import React, { useEffect, useState } from "react";
import { Image, type ImageStyle, type StyleProp, View } from "react-native";
import type { FileSource } from "@/api/client";
import { useApiClient } from "@/hooks/useApiClient";

/**
 * An image the thread's box serves (`Paths.taskAttachment`, `Paths.taskRunImage`), contained in its frame. The source
 * resolves asynchronously (the user's own box needs a minted token), so the frame stays empty until it resolves.
 */
export function AttachmentImage({
  path,
  style,
  accessibilityLabel,
}: {
  path: string;
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
      .fileSource(path)
      .then((resolved) => {
        if (active) setSource(resolved);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [api, path]);

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
