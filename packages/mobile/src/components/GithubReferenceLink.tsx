import React from "react";
import { Linking, StyleSheet, Text } from "react-native";
import CircleDot from "lucide-react-native/icons/circle-dot";
import GitPullRequest from "lucide-react-native/icons/git-pull-request";
import { githubReferenceLabel, githubReferenceUrl, type GithubReference } from "@cloudagents/composer/reference";
import { colors } from "@/theme";

/** Inline in native Text, for both plain user messages and Markdown output. */
export function GithubReferenceLink({ reference }: { reference: GithubReference }) {
  const label = githubReferenceLabel(reference.kind, reference.number);
  const Icon = reference.kind === "pr" ? GitPullRequest : CircleDot;
  return (
    <Text
      style={styles.link}
      accessibilityRole="link"
      accessibilityLabel={`${label} in ${reference.repo}`}
      onPress={() => void Linking.openURL(githubReferenceUrl(reference))}
    >
      <Icon size={14} color={colors.foreground} /> {label}
    </Text>
  );
}

const styles = StyleSheet.create({
  link: { color: colors.foreground, fontWeight: "700", textDecorationLine: "underline" },
});
