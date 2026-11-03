import React, { type ComponentRef, useEffect, useRef } from "react";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { CircleDot, GitPullRequest, type LucideIcon } from "lucide-react-native";
import { githubReferenceLabel, type GithubReferenceKind } from "@cloudagents/composer/reference";
import { RepoPicker } from "@/components/RepoPicker";
import { colors, radius, shadows, spacing } from "@/theme";

interface Option {
  readonly kind: GithubReferenceKind;
  readonly detail: string;
  readonly Icon: LucideIcon;
}

/** The two references a `#number` token can become; neither claims that the reference exists. */
const OPTIONS: readonly Option[] = [
  { kind: "pr", detail: "Reference the pull request", Icon: GitPullRequest },
  { kind: "issue", detail: "Reference the issue", Icon: CircleDot },
];

/** The DOM node behind a React Native Web view, for the focus-preserving mouse listener. */
interface WebNode {
  addEventListener?: (type: string, listener: (event: { preventDefault: () => void }) => void) => void;
  removeEventListener?: (type: string, listener: (event: { preventDefault: () => void }) => void) => void;
}

/**
 * The `#` menu above the phone composer: the PR / Issue pair for the number being typed, with the repository the
 * reference will name. Without one unambiguous repository the choices stay listed but disabled and the embedded
 * repository picker asks for one; picking a repository keeps the menu open so the parent can restore the caret.
 * Nothing is fetched here: the reader checks that the reference exists when the agent follows it.
 */
export function GithubReferenceMenu({
  number,
  repo,
  onRepoChange,
  activeIndex,
  onActiveIndexChange,
  onSelect,
}: {
  /** The number after `#`. */
  number: number;
  /** The repository the reference will name; undefined until the composer (or this picker) resolves one. */
  repo: string | undefined;
  onRepoChange: (repo: string) => void;
  activeIndex: number;
  onActiveIndexChange: (index: number) => void;
  onSelect: (kind: GithubReferenceKind) => void;
}) {
  const selectedIndex = Math.min(Math.max(activeIndex, 0), OPTIONS.length - 1);
  const card = useRef<ComponentRef<typeof View>>(null);

  // On the web, a mouse down on the menu would take focus from the composer and could close the menu before the
  // click lands. Keeping the default from moving focus lets the choices (and the repository sheet) receive the tap;
  // the parent restores the caret after a repository choice.
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const node = card.current as unknown as WebNode | null;
    if (node === null || node.addEventListener === undefined) return;
    const keepFocus = (event: { preventDefault: () => void }) => event.preventDefault();
    node.addEventListener("mousedown", keepFocus);
    return () => node.removeEventListener?.("mousedown", keepFocus);
  }, []);

  return (
    <View ref={card} style={styles.card}>
      <View style={styles.repoRow}>
        <Text style={styles.repoLabel}>Repository for #{number}</Text>
        <RepoPicker
          value={repo}
          onChange={(next) => {
            if (next !== undefined) onRepoChange(next);
          }}
          allowNone={false}
          placeholder="Choose repository"
          hitSlop={8}
        />
      </View>
      <Text style={styles.heading} accessibilityRole="header">
        Suggestions
      </Text>
      <View accessibilityRole="menu" accessibilityLabel={`Reference suggestions for #${number}`}>
        {OPTIONS.map((option, index) => {
          const selected = index === selectedIndex;
          const disabled = repo === undefined;
          const Icon = option.Icon;
          const label = githubReferenceLabel(option.kind, number);
          return (
            <Pressable
              key={option.kind}
              disabled={disabled}
              onPress={() => {
                if (repo !== undefined) onSelect(option.kind);
              }}
              onPressIn={() => onActiveIndexChange(index)}
              onHoverIn={() => onActiveIndexChange(index)}
              onFocus={() => onActiveIndexChange(index)}
              accessibilityRole="menuitem"
              accessibilityState={{ selected, disabled }}
              aria-selected={selected}
              aria-disabled={disabled}
              accessibilityLabel={`${label}${repo === undefined ? "" : ` in ${repo}`}. ${option.detail}`}
              accessibilityHint={
                disabled ? "Choose a repository first" : "Adds this reference to the message"
              }
              style={({ pressed }) => [
                styles.option,
                selected && styles.optionSelected,
                pressed && styles.optionPressed,
                disabled && styles.optionDisabled,
              ]}
            >
              <Icon size={16} color={disabled ? colors.mutedForeground : colors.foreground} />
              <View style={styles.optionText}>
                <View style={styles.optionTitleRow}>
                  <Text style={styles.optionTitle}>{label}</Text>
                  <Text style={styles.optionRepo} numberOfLines={1}>
                    {repo ?? "Repository needed"}
                  </Text>
                </View>
                <Text style={styles.optionDetail}>{option.detail}</Text>
              </View>
            </Pressable>
          );
        })}
      </View>
      {repo === undefined ? (
        <Text style={styles.note} accessibilityLiveRegion="polite">
          Choose a repository to add this reference.
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.xl,
    backgroundColor: colors.secondary,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: "hidden",
    marginBottom: spacing.xs,
    ...shadows.soft,
  },
  repoRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  repoLabel: { flexShrink: 1, color: colors.mutedForeground, fontSize: 12 },
  heading: {
    color: colors.mutedForeground,
    fontSize: 12,
    fontWeight: "600",
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xs,
  },
  option: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    minHeight: 48,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    marginHorizontal: spacing.xs,
  },
  optionSelected: { backgroundColor: colors.white06 },
  optionPressed: { backgroundColor: colors.white08 },
  optionDisabled: { opacity: 0.5 },
  optionText: { flex: 1, minWidth: 0 },
  optionTitleRow: { flexDirection: "row", alignItems: "baseline", gap: spacing.sm },
  optionTitle: {
    flexShrink: 0,
    color: colors.foreground,
    fontSize: 14,
    fontWeight: "700",
    textDecorationLine: "underline",
  },
  optionRepo: { flexShrink: 1, color: colors.mutedForeground, fontSize: 12 },
  optionDetail: { color: colors.mutedForeground, fontSize: 12, marginTop: 2 },
  note: { color: colors.mutedForeground, fontSize: 12, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
});
