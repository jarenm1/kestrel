import React, { useEffect, useImperativeHandle, useRef, useState } from "react";
import { View } from "react-native";
import type { HtmlViewHandle, HtmlViewProps } from "./HtmlView";
import { parseHtmlMessage } from "./htmlMessage";

const frameStyle: React.CSSProperties = { width: "100%", height: "100%", border: 0, display: "block" };

/**
 * The web build's HtmlView: the page in an iframe, either `srcdoc` or the URL. The iframe shares the app's origin
 * (the desktop embed is served by the same app host), and the preview wrapper still sandboxes the dev server in its
 * own inner frame. Messages come from the iframe's window only.
 */
export function HtmlView({ style, ref, onMessage, ...source }: HtmlViewProps) {
  const frame = useRef<HTMLIFrameElement | null>(null);
  const [generation, setGeneration] = useState(0);
  const uri = "uri" in source ? source.uri : undefined;
  const html = "html" in source ? source.html : undefined;
  // Host messages go to the iframe's own origin only: a URL's origin, or the app's for inline HTML (which inherits it).
  const origin = uri !== undefined ? new URL(uri, window.location.href).origin : window.location.origin;
  useImperativeHandle(ref, (): HtmlViewHandle => ({
    reload: () => setGeneration((g) => g + 1),
    injectJavaScript: (script) => {
      const target = frame.current?.contentWindow as (Window & { eval(code: string): unknown }) | null | undefined;
      target?.eval(script);
    },
    postMessage: (data) => frame.current?.contentWindow?.postMessage(data, origin),
  }));
  useEffect(() => {
    if (!onMessage) return;
    const listener = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      onMessage(parseHtmlMessage(event.data));
    };
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, [onMessage]);
  return (
    <View style={style}>
      <iframe
        key={generation}
        ref={frame}
        src={uri}
        srcDoc={html}
        allow="autoplay"
        style={frameStyle}
      />
    </View>
  );
}
