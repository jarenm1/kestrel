import React, { useImperativeHandle, useRef, useState } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import type { HtmlViewHandle } from "./HtmlView";

const frameStyle: React.CSSProperties = { width: "100%", height: "100%", border: 0, display: "block" };

/**
 * The web build's HtmlView: the page in a `srcdoc` iframe. It shares the app's origin like the native WebView's page
 * runs with the app's network access; the preview wrapper still sandboxes the dev server in its own inner frame.
 */
export function HtmlView({
  html,
  style,
  ref,
}: {
  html: string;
  style?: StyleProp<ViewStyle>;
  ref?: React.Ref<HtmlViewHandle>;
}) {
  const frame = useRef<HTMLIFrameElement | null>(null);
  const [generation, setGeneration] = useState(0);
  useImperativeHandle(ref, () => ({
    reload: () => setGeneration((g) => g + 1),
    injectJavaScript: (script) => {
      const target = frame.current?.contentWindow as (Window & { eval(code: string): unknown }) | null | undefined;
      target?.eval(script);
    },
  }));
  return (
    <View style={style}>
      <iframe key={generation} ref={frame} srcDoc={html} allow="autoplay" style={frameStyle} />
    </View>
  );
}
