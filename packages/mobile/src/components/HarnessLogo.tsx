import React from "react";
import { SvgXml } from "react-native-svg";
import { colors } from "@/theme";
import { HARNESS_LOGOS, type HarnessId } from "@cloudagents/ui/harness-logos";

/** The harness's own mark, sized for a menu row. Monochrome logos take the text color, as on the web. */
export const HarnessLogo = React.memo(function HarnessLogo({
  harness,
  size = 16,
}: {
  readonly harness: HarnessId;
  readonly size?: number;
}) {
  const logo = HARNESS_LOGOS[harness];
  const xml = logo.monochrome
    ? logo.xml.replace(/fill="(?:currentColor|#000000)"/gi, `fill="${colors.foreground}"`)
    : logo.xml;
  return <SvgXml xml={xml} width={size} height={size} accessible={false} />;
});
