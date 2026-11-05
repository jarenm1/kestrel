import React, { useImperativeHandle, useMemo, useRef } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import { WebView, type WebViewMessageEvent, type WebViewProps } from "react-native-webview";
import { parseHtmlMessage } from "./htmlMessage";

// The WebView class's generic props are not inferred through `React.ComponentType`.
const SafeWebView = WebView as unknown as React.ComponentClass<WebViewProps & React.ClassAttributes<WebView>>;

export interface HtmlViewHandle {
  reload(): void;
  injectJavaScript(script: string): void;
  /** Delivers a JSON-serializable value to the page as a `message` event on its `window`. */
  postMessage(data: unknown): void;
}

/** A page to show: inline HTML, or a URL (the desktop embed at `<app host>/embed/desktop#…`). */
export type HtmlViewSource = { html: string } | { uri: string };

export type HtmlViewProps = HtmlViewSource & {
  style?: StyleProp<ViewStyle>;
  ref?: React.Ref<HtmlViewHandle>;
  /** Messages the page sends to the host, parsed (see `parseHtmlMessage`). */
  onMessage?: (data: unknown) => void;
};

/**
 * A self-contained page (the desktop embed, the preview frame wrapper). Native: a WebView with scripts, storage and
 * inline autoplaying media; the page reaches the host through `window.ReactNativeWebView.postMessage`. The web build
 * uses `HtmlView.web.tsx`.
 */
export function HtmlView({ style, ref, onMessage, ...source }: HtmlViewProps) {
  const webView = useRef<WebView | null>(null);
  useImperativeHandle(ref, () => ({
    reload: () => webView.current?.reload(),
    injectJavaScript: (script) => webView.current?.injectJavaScript(script),
    postMessage: (data) => webView.current?.injectJavaScript(`window.postMessage(${JSON.stringify(data)}, "*"); true;`),
  }));
  const uri = "uri" in source ? source.uri : undefined;
  const html = "html" in source ? source.html : undefined;
  // A stable source: a new object with the same URL would reload the page.
  const webSource = useMemo(() => (uri !== undefined ? { uri } : { html: html ?? "" }), [uri, html]);
  return (
    <SafeWebView
      ref={webView}
      source={webSource}
      style={style}
      javaScriptEnabled
      domStorageEnabled
      mediaPlaybackRequiresUserAction={false}
      allowsInlineMediaPlayback
      scrollEnabled={false}
      onMessage={(event: WebViewMessageEvent) => onMessage?.(parseHtmlMessage(event.nativeEvent.data))}
    />
  );
}
