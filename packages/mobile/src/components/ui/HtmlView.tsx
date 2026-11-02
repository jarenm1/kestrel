import React, { useImperativeHandle, useRef } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import { WebView } from "react-native-webview";

// The WebView class's generic props are not inferred through `React.ComponentType`.
const SafeWebView = WebView as unknown as React.ComponentType<any>;

export interface HtmlViewHandle {
  reload(): void;
  injectJavaScript(script: string): void;
}

/**
 * A self-contained HTML page (the desktop stream player, the preview frame wrapper). Native: a WebView with scripts,
 * storage and inline autoplaying media. The web build uses `HtmlView.web.tsx`.
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
  const webView = useRef<HtmlViewHandle | null>(null);
  useImperativeHandle(ref, () => ({
    reload: () => webView.current?.reload(),
    injectJavaScript: (script) => webView.current?.injectJavaScript(script),
  }));
  return (
    <SafeWebView
      ref={webView}
      source={{ html }}
      style={style}
      javaScriptEnabled
      domStorageEnabled
      mediaPlaybackRequiresUserAction={false}
      allowsInlineMediaPlayback
      scrollEnabled={false}
    />
  );
}
