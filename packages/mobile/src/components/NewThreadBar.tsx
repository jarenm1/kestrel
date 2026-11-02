import React, { useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { Schema } from "effect";
import { FolderGit2, GitBranch, Lock, type LucideIcon, Plug, Server } from "lucide-react-native";
import { BranchName, type BoxList } from "@cloudagents/protocol";
import { ApiError } from "@/api/client";
import { createQueries } from "@/api/queries";
import { PickerSheet } from "@/components/PickerSheet";
import { useApiClient } from "@/hooks/useApiClient";
import { errorText, repoShortName } from "@/lib/format";
import { useNavigation } from "@/nav/navigation";
import { colors, radius, spacing } from "@/theme";

/** Key of the "No repository" option; repository keys are GitHub "owner/name", which never equals it. */
const NO_REPO = "";
/** Key of Kestrel's box, whose id is `null`. */
const KESTREL_BOX = "kestrel";

/**
 * A trigger in the bar: icon and the current choice (or only a status dot). No chevron, unlike the web's: on a phone
 * the repository, branch and box only fit side by side without it.
 */
function BarButton({
  icon: Icon,
  label,
  onPress,
  disabled,
  accessibilityLabel,
  dot,
}: {
  icon: LucideIcon;
  /** Absent for an icon-only trigger; its accessibility label names the choice. */
  label?: string;
  onPress: () => void;
  disabled?: boolean;
  accessibilityLabel: string;
  dot?: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={4}
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
 * The GitHub repositories the user can read, with a filter; `undefined` leaves the choice to the agent. Without a
 * GitHub connection it points to Connections instead.
 */
function RepoPicker({ value, onChange, disabled }: { value: string | undefined; onChange: (repo: string | undefined) => void; disabled: boolean }) {
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
        label={value === undefined ? "No repository" : repoShortName(value)}
        accessibilityLabel={`Repository: ${value ?? "none, the agent checks out what it needs"}`}
        onPress={() => setOpen(true)}
        disabled={disabled}
      />
      <PickerSheet
        open={open}
        onClose={() => setOpen(false)}
        title="Repository"
        pinned={[{ key: NO_REPO, label: "No repository", detail: "The agent checks out what it needs" }]}
        options={(repos.data ?? []).map((repo) => ({
          key: repo.fullName,
          label: repo.fullName,
          trailing: repo.private ? <Lock size={14} color={colors.mutedForeground} accessibilityLabel="Private" /> : undefined,
        }))}
        selected={value ?? NO_REPO}
        onSelect={(key) => onChange(key === NO_REPO ? undefined : key)}
        filter={{ placeholder: "Filter repositories", empty: (q) => `No repository matches “${q}”.` }}
        message={message}
        footer={
          notConnected ? (
            <Pressable
              style={({ pressed }) => [styles.footerRow, pressed && styles.triggerPressed]}
              accessibilityRole="button"
              onPress={() => {
                setOpen(false);
                nav.navigate({ name: "connections" });
              }}
            >
              <Plug size={18} color={colors.foreground} />
              <Text style={styles.footerText}>Connections</Text>
            </Pressable>
          ) : undefined
        }
      />
    </>
  );
}

/**
 * `repo`'s branches to start from, with a filter; `undefined` is the repository's default branch, which the box
 * resolves. Branch names a checkout cannot take (see `BranchName`) are left out.
 */
function BranchPicker({
  repo,
  value,
  onChange,
  disabled,
}: {
  repo: string;
  value: string | undefined;
  onChange: (branch: string | undefined) => void;
  disabled: boolean;
}) {
  const { api } = useApiClient();
  const queries = useMemo(() => createQueries(api), [api]);
  const [open, setOpen] = useState(false);
  const branches = useQuery(queries.githubBranches(repo));
  const listed = useQuery(queries.githubRepos()).data?.find((r) => r.fullName === repo)?.defaultBranch;
  // The listing puts the default branch first; before it loads, the repository list knows it.
  const defaultBranch = branches.data?.[0] ?? listed ?? "main";
  const names = (branches.data ?? []).filter(Schema.is(BranchName));
  return (
    <>
      <BarButton
        icon={GitBranch}
        label={value ?? defaultBranch}
        accessibilityLabel={`Branch the thread starts from: ${value ?? defaultBranch}`}
        onPress={() => setOpen(true)}
        disabled={disabled}
      />
      <PickerSheet
        open={open}
        onClose={() => setOpen(false)}
        title="Branch to start from"
        options={names.map((name) => ({ key: name, label: name, detail: name === defaultBranch ? "default" : undefined }))}
        selected={value ?? defaultBranch}
        onSelect={(name) => onChange(name === defaultBranch ? undefined : name)}
        filter={{ placeholder: "Filter branches", empty: (q) => `No branch matches “${q}”.` }}
        message={branches.isPending ? "Loading branches…" : branches.isError ? errorText(branches.error) : undefined}
      />
    </>
  );
}

/**
 * The box the thread runs on: in the bar only its icon and online dot (a phone has no room for the name next to a
 * repository and branch; the sheet and the thread's box pill name it). The app shows one box's threads at a time
 * (the active box), so picking another box here switches the app to it: the new thread is then created there and
 * shows in the thread list.
 */
function BoxPicker({
  list,
  online,
  onChange,
  disabled,
}: {
  list: Pick<BoxList, "boxes" | "activeBoxId">;
  online: boolean | undefined;
  onChange: (boxId: string | null) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const active = list.activeBoxId;
  const name = active === null ? "Kestrel's box" : (list.boxes.find((box) => box.id === active)?.name ?? "Box");
  return (
    <>
      <BarButton
        icon={Server}
        accessibilityLabel={`Box: ${name}, ${online === undefined ? "checking" : online ? "online" : "offline"}`}
        dot={online === undefined ? colors.mutedForeground + "66" : online ? colors.success : colors.destructive}
        onPress={() => setOpen(true)}
        disabled={disabled}
      />
      <PickerSheet
        open={open}
        onClose={() => setOpen(false)}
        title="Box"
        options={[
          { key: KESTREL_BOX, label: "Kestrel's box" },
          ...list.boxes.map((box) => ({ key: box.id, label: box.name })),
        ]}
        selected={active ?? KESTREL_BOX}
        onSelect={(key) => {
          const next = key === KESTREL_BOX ? null : key;
          if (next !== active) onChange(next);
        }}
      />
    </>
  );
}

/**
 * The web new-thread bar under the composer: the repository and branch the thread starts in, and the box it runs on.
 * The box picker shows only for someone with a box of their own; everyone else runs on Kestrel's box.
 */
export function NewThreadBar({
  repo,
  onRepoChange,
  branch,
  onBranchChange,
  boxes,
  boxOnline,
  onBoxChange,
  disabled,
}: {
  repo: string | undefined;
  onRepoChange: (repo: string | undefined) => void;
  branch: string | undefined;
  onBranchChange: (branch: string | undefined) => void;
  boxes: Pick<BoxList, "boxes" | "activeBoxId">;
  boxOnline: boolean | undefined;
  onBoxChange: (boxId: string | null) => void;
  disabled: boolean;
}) {
  return (
    <View style={styles.bar}>
      <View style={styles.left}>
        <RepoPicker value={repo} onChange={onRepoChange} disabled={disabled} />
        {repo !== undefined ? <BranchPicker repo={repo} value={branch} onChange={onBranchChange} disabled={disabled} /> : null}
      </View>
      {boxes.boxes.length > 0 ? (
        <BoxPicker list={boxes} online={boxOnline} onChange={onBoxChange} disabled={disabled} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  /** The web's `mx-4 rounded-b-xl bg-input`: an inset tab hanging under the composer. */
  bar: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    marginHorizontal: spacing.lg,
    paddingHorizontal: 6,
    paddingVertical: spacing.xs,
    borderBottomLeftRadius: radius.lg,
    borderBottomRightRadius: radius.lg,
    backgroundColor: colors.input,
  },
  left: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: spacing.xs },
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
