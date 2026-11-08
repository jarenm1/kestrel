import React, { useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { Schema } from "effect";
import GitBranch from "lucide-react-native/icons/git-branch";
import Server from "lucide-react-native/icons/server";
import { BranchName, type BoxList } from "@cloudagents/protocol";
import { createQueries } from "@/api/queries";
import { PickerSheet } from "@/components/PickerSheet";
import { BarButton, RepoPicker } from "@/components/RepoPicker";
import { useApiClient } from "@/hooks/useApiClient";
import { errorText } from "@/lib/format";
import { colors, radius, spacing } from "@/theme";

/** Key of Kestrel's box, whose id is `null`. */
const KESTREL_BOX = "kestrel";

/** Key of the branch sheet's option that leaves the choice to the agent; no branch has an empty name. */
const AGENT_PICKS = "";

/**
 * `repo`'s branches to start from, with a filter; `undefined` leaves the choice to the agent. Branch names a checkout
 * cannot take (see `BranchName`) are left out.
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
  // The listing puts the default branch first.
  const defaultBranch = branches.data?.[0];
  const names = (branches.data ?? []).filter(Schema.is(BranchName));
  return (
    <>
      <BarButton
        icon={GitBranch}
        label={value ?? "Agent picks"}
        accessibilityLabel={value === undefined ? "The agent picks the branch to start from" : `Branch the thread starts from: ${value}`}
        onPress={() => setOpen(true)}
        disabled={disabled}
      />
      <PickerSheet
        open={open}
        onClose={() => setOpen(false)}
        title="Branch to start from"
        options={[
          { key: AGENT_PICKS, label: "Agent picks", detail: "The agent picks a branch or pull request" },
          ...names.map((name) => ({ key: name, label: name, detail: name === defaultBranch ? "default" : undefined })),
        ]}
        selected={value ?? AGENT_PICKS}
        onSelect={(name) => onChange(name === AGENT_PICKS ? undefined : name)}
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
});
