import React, { useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { FolderGit2, Lock, type LucideIcon, User } from "lucide-react-native";
import { ApiError } from "@/api/errors";
import { createQueries } from "@/api/queries";
import { PickerSheet } from "@/components/PickerSheet";
import { useApiClient } from "@/hooks/useApiClient";
import { errorText, repoShortName } from "@/lib/format";
import { useNavigation } from "@/nav/navigation";
import { colors, radius, spacing } from "@/theme";

/** Key of the "No repository" option; repository keys are GitHub "owner/name", which never equals it. */
const NO_REPO = "";

/**
 * A compact trigger: icon and the current choice (or only a status dot). No chevron, unlike the web's: on a phone the
 * repository, branch and box only fit side by side without it.
 */
export function BarButton({
  icon: Icon,
  label,
  onPress,
  disabled,
  accessibilityLabel,
  dot,
  hitSlop = 4,
}: {
  icon: LucideIcon;
  /** Absent for an icon-only trigger; its accessibility label names the choice. */
  label?: string;
  onPress: () => void;
  disabled?: boolean;
  accessibilityLabel: string;
  dot?: string;
  hitSlop?: number;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={hitSlop}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => [styles.trigger, pressed && styles.triggerPressed, disabled && styles.disabled]}
    >
      <Icon size={14} color={colors.mutedForeground} />
      {label !== undefined ? (
        <Text style={styles.triggerText} numberOfLines={1}>
          {label}
        </Text>
      ) : null}
      {dot !== undefined ? <View style={[styles.dot, { backgroundColor: dot }]} /> : null}
    </Pressable>
  );
}

/**
 * GitHub repositories the user can read, with a filter; `undefined` leaves the choice to the agent. Without a
 * GitHub connection it points to Profile instead (where GitHub access lives, as on the web). With `allowNone` false
 * (a reference must name a repository) the sheet only lists repositories and the trigger prompts for one.
 */
export function RepoPicker({
  value,
  onChange,
  disabled = false,
  allowNone = true,
  placeholder = "No repository",
  hitSlop = 4,
}: {
  value: string | undefined;
  onChange: (repo: string | undefined) => void;
  disabled?: boolean;
  /** Offers "No repository" and reports `undefined`; false requires a repository choice. */
  allowNone?: boolean;
  /** Trigger label while `value` is undefined and `allowNone` is false. */
  placeholder?: string;
  hitSlop?: number;
}) {
  const { api } = useApiClient();
  const queries = useMemo(() => createQueries(api), [api]);
  const nav = useNavigation();
  const [open, setOpen] = useState(false);
  const repos = useQuery({ ...queries.githubRepos(), enabled: open || value !== undefined });
  const notConnected = repos.error instanceof ApiError && repos.error.status === 404;
  const message = notConnected
    ? "Connect GitHub to start in one of your repositories."
    : repos.isPending
      ? "Loading repositories…"
      : repos.isError
        ? errorText(repos.error)
        : repos.data.length === 0
          ? "GitHub lists no repositories."
          : undefined;
  return (
    <>
      <BarButton
        icon={FolderGit2}
        label={value === undefined ? (allowNone ? "No repository" : placeholder) : repoShortName(value)}
        accessibilityLabel={
          value !== undefined
            ? `Repository: ${value}`
            : allowNone
              ? "Repository: none, the agent checks out what it needs"
              : "Repository: choose one"
        }
        onPress={() => setOpen(true)}
        disabled={disabled}
        hitSlop={hitSlop}
      />
      <PickerSheet
        open={open}
        onClose={() => setOpen(false)}
        title="Repository"
        pinned={allowNone ? [{ key: NO_REPO, label: "No repository", detail: "The agent checks out what it needs" }] : []}
        options={(repos.data ?? []).map((repo) => ({
          key: repo.fullName,
          label: repo.fullName,
          trailing: repo.private ? <Lock size={14} color={colors.mutedForeground} accessibilityLabel="Private" /> : undefined,
        }))}
        selected={value ?? (allowNone ? NO_REPO : undefined)}
        onSelect={(key) => {
          if (key === NO_REPO) {
            if (allowNone) onChange(undefined);
            return;
          }
          onChange(key);
        }}
        filter={{ placeholder: "Filter repositories", empty: (q) => `No repository matches “${q}”.` }}
        message={message}
        footer={
          notConnected ? (
            <Pressable
              style={({ pressed }) => [styles.footerRow, pressed && styles.triggerPressed]}
              accessibilityRole="button"
              onPress={() => {
                setOpen(false);
                nav.navigate({ name: "settings", section: "profile" });
              }}
            >
              <User size={18} color={colors.foreground} />
              <Text style={styles.footerText}>Profile</Text>
            </Pressable>
          ) : undefined
        }
      />
    </>
  );
}

const styles = StyleSheet.create({
  trigger: {
    flexShrink: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    height: 28,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.full,
  },
  triggerPressed: { backgroundColor: colors.white06 },
  disabled: { opacity: 0.5 },
  triggerText: { flexShrink: 1, color: colors.mutedForeground, fontSize: 12 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  footerRow: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 44, paddingHorizontal: spacing.md, borderRadius: radius.md },
  footerText: { color: colors.foreground, fontSize: 15 },
});
