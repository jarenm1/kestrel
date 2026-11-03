import React, { type ReactNode, useState } from "react";
import { Linking, Modal, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import Svg, { Path } from "react-native-svg";
import { Schema } from "effect";
import { EllipsisVertical, GitPullRequest } from "lucide-react-native";
import { GithubRepoSlug, type Checkout } from "@cloudagents/protocol";
import { Button } from "@/components/ui/Button";
import { colors, radius, spacing } from "@/theme";

const isGithubRepo = Schema.is(GithubRepoSlug);

/** Most of the screen the links sheet may cover; past that its list scrolls. */
const SHEET_MAX_SHARE = 0.75;

/** A pull request link as the thread view labels it ("PR #12", or "kestrel PR #12" with several repos). */
export interface PullRequestLink {
  readonly id: string;
  readonly url: string;
  readonly label: string;
}

/** GitHub's mark (Octicons `mark-github`); lucide has no brand icons. */
function GitHubMark({ size, color }: { size: number; color: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 16 16" fill={color} accessible={false}>
      <Path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z" />
    </Svg>
  );
}

interface Link {
  readonly key: string;
  readonly url: string;
  readonly label: string;
  readonly icon: (color: string, size: number) => ReactNode;
}

/**
 * The thread's outside links in the top bar: its pull requests, then its repositories on GitHub (the web app's PR
 * buttons and `ThreadRepoButton`). One link is one button; several share a single button that opens a sheet of them,
 * so the bar never grows past the screen however many repos the thread checked out. Repos that are not on GitHub have
 * no page and are left out.
 */
export function ThreadLinks({ pullRequests, checkouts }: { pullRequests: readonly PullRequestLink[]; checkouts: readonly Checkout[] }) {
  const [picking, setPicking] = useState(false);
  const { height } = useWindowDimensions();
  const links: Link[] = [
    ...pullRequests.map((pr) => ({
      key: `pr:${pr.id}`,
      url: pr.url,
      label: pr.label,
      icon: (color: string, size: number) => <GitPullRequest size={size} color={color} />,
    })),
    ...checkouts.flatMap((checkout) =>
      isGithubRepo(checkout.repo)
        ? [
            {
              key: `repo:${checkout.repo}`,
              url: `https://github.com/${checkout.repo}`,
              label: `${checkout.repo} on GitHub`,
              icon: (color: string, size: number) => <GitHubMark size={size} color={color} />,
            },
          ]
        : [],
    ),
  ];
  const [only] = links;
  if (only === undefined) return null;
  if (links.length === 1) {
    return (
      <Button variant="ghost" size="icon" accessibilityLabel={`Open ${only.label}`} onPress={() => void Linking.openURL(only.url)}>
        {only.icon(colors.mutedForeground, 16)}
      </Button>
    );
  }
  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        icon={EllipsisVertical}
        accessibilityLabel="Pull requests and repositories"
        onPress={() => setPicking(true)}
      />
      <Modal visible={picking} transparent animationType="fade" onRequestClose={() => setPicking(false)}>
        <View style={styles.container}>
          {/* A sibling under the sheet, not its parent, so a drag through the list scrolls instead of closing it. */}
          <Pressable style={styles.backdrop} accessibilityLabel="Close" onPress={() => setPicking(false)} />
          {/* Never taller than most of the screen: many repos, landscape or large text scroll inside it. */}
          <View style={[styles.sheet, { maxHeight: height * SHEET_MAX_SHARE }]}>
            <Text style={styles.heading}>Open</Text>
            <ScrollView contentContainerStyle={styles.list} bounces={false}>
              {links.map((link) => (
                <Pressable
                  key={link.key}
                  style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
                  accessibilityRole="link"
                  onPress={() => {
                    setPicking(false);
                    void Linking.openURL(link.url);
                  }}
                >
                  {link.icon(colors.foreground, 18)}
                  <Text style={styles.label} numberOfLines={1}>
                    {link.label}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: "flex-end" },
  backdrop: { ...StyleSheet.absoluteFill, backgroundColor: colors.scrim },
  sheet: {
    backgroundColor: colors.secondary,
    borderTopLeftRadius: radius.xxl,
    borderTopRightRadius: radius.xxl,
    padding: spacing.sm,
    paddingBottom: spacing.xxl,
  },
  list: { gap: 2 },
  heading: { color: colors.mutedForeground, fontSize: 12, fontWeight: "600", padding: spacing.md },
  row: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 44, paddingHorizontal: spacing.md, borderRadius: radius.md },
  rowPressed: { backgroundColor: colors.accent },
  label: { flex: 1, color: colors.foreground, fontSize: 15 },
});
