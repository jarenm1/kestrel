import React, { type ReactNode, useMemo } from "react";
import { Linking, StyleSheet, Text, type TextStyle, View } from "react-native";
// The gesture handler's ScrollView, so a code block or table scrolls sideways instead of opening the Desktop/Diff panel.
import { ScrollView } from "react-native-gesture-handler";
import type { PhrasingContent, RootContent, Table } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { colors, fonts, radius, spacing } from "@/theme";

const BODY_SIZE = 15;
const HEADING_SIZE: Record<number, number> = { 1: 24, 2: 20, 3: 17, 4: 15, 5: 15, 6: 15 };

/** Inline content as nested Text; single newlines stay line breaks (the web app's remark-breaks). */
function inline(nodes: readonly PhrasingContent[], keyPrefix: string): ReactNode[] {
  return nodes.map((node, i) => {
    const key = `${keyPrefix}.${i}`;
    switch (node.type) {
      case "text":
        return node.value;
      case "break":
        return "\n";
      case "strong":
        return (
          <Text key={key} style={styles.strong}>
            {inline(node.children, key)}
          </Text>
        );
      case "emphasis":
        return (
          <Text key={key} style={styles.em}>
            {inline(node.children, key)}
          </Text>
        );
      case "delete":
        return (
          <Text key={key} style={styles.del}>
            {inline(node.children, key)}
          </Text>
        );
      case "inlineCode":
        return (
          <Text key={key} style={styles.inlineCode}>
            {node.value}
          </Text>
        );
      case "link":
        return (
          <Text key={key} style={styles.link} onPress={() => void Linking.openURL(node.url)} accessibilityRole="link">
            {inline(node.children, key)}
          </Text>
        );
      case "image":
        // Remote images are not loaded inline; the alt text links to them.
        return (
          <Text key={key} style={styles.link} onPress={() => void Linking.openURL(node.url)} accessibilityRole="link">
            {node.alt || node.url}
          </Text>
        );
      case "html":
        // Raw HTML is not rendered (as on the web); its source shows as text.
        return node.value;
      default:
        return "children" in node ? inline(node.children as PhrasingContent[], key) : null;
    }
  });
}

function TableView({ node, keyPrefix }: { node: Table; keyPrefix: string }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
      <View>
        {node.children.map((row, r) => (
          <View key={r} style={[styles.tableRow, r > 0 && styles.tableRowBorder]}>
            {row.children.map((cell, c) => (
              <Text key={c} style={[styles.cell, r === 0 && styles.headCell]}>
                {inline(cell.children, `${keyPrefix}.${r}.${c}`)}
              </Text>
            ))}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

function block(node: RootContent, key: string, ordinal?: string): ReactNode {
  switch (node.type) {
    case "paragraph":
      return (
        <Text key={key} style={styles.body}>
          {inline(node.children, key)}
        </Text>
      );
    case "heading":
      return (
        <Text key={key} style={[styles.body, styles.heading, { fontSize: HEADING_SIZE[node.depth] }]}>
          {inline(node.children, key)}
        </Text>
      );
    case "code":
      return (
        <ScrollView key={key} horizontal style={styles.pre} contentContainerStyle={styles.preContent}>
          <Text style={styles.preText} selectable>
            {node.value}
          </Text>
        </ScrollView>
      );
    case "blockquote":
      return (
        <View key={key} style={styles.quote}>
          {node.children.map((child, i) => block(child, `${key}.${i}`))}
        </View>
      );
    case "list": {
      const start = node.start ?? 1;
      return (
        <View key={key} style={styles.list}>
          {node.children.map((item, i) => block(item, `${key}.${i}`, node.ordered ? `${start + i}.` : "•"))}
        </View>
      );
    }
    case "listItem": {
      const marker = node.checked === true ? "☑" : node.checked === false ? "☐" : (ordinal ?? "•");
      return (
        <View key={key} style={styles.item}>
          <Text style={[styles.body, styles.marker]}>{marker}</Text>
          <View style={styles.itemBody}>{node.children.map((child, i) => block(child, `${key}.${i}`))}</View>
        </View>
      );
    }
    case "thematicBreak":
      return <View key={key} style={styles.hr} />;
    case "table":
      return <TableView key={key} node={node} keyPrefix={key} />;
    case "html":
      return (
        <Text key={key} style={styles.body}>
          {node.value}
        </Text>
      );
    default:
      return null;
  }
}

/** Agent output as GitHub-flavoured markdown, styled like the web app's `prose prose-invert`. */
export function Markdown({ text }: { text: string }) {
  const tree = useMemo(
    () => fromMarkdown(text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }),
    [text]
  );
  return <View style={styles.root}>{tree.children.map((node, i) => block(node, String(i)))}</View>;
}

const body: TextStyle = { color: colors.foreground, fontSize: BODY_SIZE, lineHeight: 22 };

const styles = StyleSheet.create({
  root: { gap: spacing.md },
  body,
  heading: { fontWeight: "600", lineHeight: undefined, letterSpacing: -0.2 },
  strong: { fontWeight: "700" },
  em: { fontStyle: "italic" },
  del: { textDecorationLine: "line-through" },
  inlineCode: {
    fontFamily: fonts.mono,
    fontSize: BODY_SIZE - 2,
    backgroundColor: "rgba(255,255,255,0.07)",
    borderRadius: 6,
  },
  link: { color: colors.foreground, textDecorationLine: "underline" },
  pre: { backgroundColor: colors.code, borderRadius: radius.md, flexGrow: 0 },
  preContent: { paddingHorizontal: 14, paddingVertical: 12 },
  preText: { color: colors.foreground, fontFamily: fonts.mono, fontSize: 12, lineHeight: 18 },
  quote: { borderLeftWidth: 3, borderLeftColor: colors.white12, paddingLeft: spacing.md, gap: spacing.sm },
  list: { gap: spacing.xs },
  item: { flexDirection: "row", gap: spacing.sm },
  marker: { minWidth: 14, color: colors.mutedForeground },
  itemBody: { flex: 1, gap: spacing.xs },
  hr: { height: StyleSheet.hairlineWidth, backgroundColor: colors.white12 },
  tableRow: { flexDirection: "row" },
  tableRowBorder: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  cell: { ...body, minWidth: 96, maxWidth: 260, paddingHorizontal: spacing.sm, paddingVertical: 6 },
  headCell: { color: colors.mutedForeground, fontWeight: "600" },
});
