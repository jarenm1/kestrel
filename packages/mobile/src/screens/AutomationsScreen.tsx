import React, { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Automation, AutomationRun, TriggerAutomationBody } from "@cloudagents/protocol";
import { createQueries, keys } from "@/api/queries";
import { AutomationEditor, type AutomationEditorTarget } from "@/components/AutomationEditor";
import { ScreenHeader } from "@/components/ScreenHeader";
import { useApiClient } from "@/hooks/useApiClient";
import { useNavigation } from "@/nav/navigation";
import { errorText } from "@/lib/format";
import { describeTrigger, formatWhen, promptPreview } from "@/lib/automations";
import { colors, radius, spacing } from "@/theme";

/** Lists every automation; toggles, edits, removes and runs them, and shows each one's recent runs. */
export function AutomationsScreen() {
  const { api } = useApiClient();
  const { back } = useNavigation();
  const queries = useMemo(() => createQueries(api), [api]);
  const automations = useQuery(queries.automations());
  const [editing, setEditing] = useState<AutomationEditorTarget | null>(null);
  const rows = automations.data ?? [];

  return (
    <View style={styles.container}>
      <ScreenHeader title="Automations" onBack={back} />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.subtitle}>Tasks the agent starts on a schedule or when a pull request changes.</Text>

        <Pressable style={styles.primaryButton} onPress={() => setEditing({ kind: "create" })} accessibilityRole="button">
          <Text style={styles.primaryText}>New automation</Text>
        </Pressable>

        {automations.error ? (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{errorText(automations.error)}</Text>
          </View>
        ) : null}
        {automations.isPending ? <ActivityIndicator color={colors.primary} /> : null}

        {automations.data && rows.length === 0 ? (
          <View style={styles.card}>
            <Text style={styles.emptyTitle}>No automations yet.</Text>
            <Text style={styles.subtitle}>
              Ask the agent in a thread to set one up, for example “review open pull requests every weekday at 9am”,
              and it will appear here.
            </Text>
          </View>
        ) : null}

        {rows.map((automation) => (
          <AutomationRow
            key={automation.id}
            automation={automation}
            onEdit={() => setEditing({ kind: "edit", automation })}
          />
        ))}
      </ScrollView>

      <AutomationEditor target={editing} onClose={() => setEditing(null)} />
    </View>
  );
}

function AutomationRow({ automation, onEdit }: { automation: Automation; onEdit: () => void }) {
  const { api } = useApiClient();
  const { push } = useNavigation();
  const queryClient = useQueryClient();
  const queries = useMemo(() => createQueries(api), [api]);
  const [showRuns, setShowRuns] = useState(false);
  const [pullRequest, setPullRequest] = useState("");
  const [lastRun, setLastRun] = useState<AutomationRun | null>(null);
  const runs = useQuery({ ...queries.automationRuns(automation.id), enabled: showRuns });

  const isGithub = automation.trigger._tag === "github";
  const pullRequestNumber = Number(pullRequest.trim());
  const pullRequestValid = Number.isInteger(pullRequestNumber) && pullRequestNumber > 0;

  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api.updateAutomation(automation.id, { enabled }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.automations }),
  });
  const remove = useMutation({
    mutationFn: () => api.deleteAutomation(automation.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.automations }),
  });
  const run = useMutation({
    mutationFn: (body: TriggerAutomationBody) => api.triggerAutomation(automation.id, body),
    onSuccess: (result) => {
      setLastRun(result);
      return queryClient.invalidateQueries({ queryKey: keys.automationRuns(automation.id) });
    },
  });

  const error = toggle.error ?? remove.error ?? run.error;

  return (
    <View style={styles.card}>
      <View style={styles.headerRow}>
        <View style={styles.titleBlock}>
          <View style={styles.titleLine}>
            <Text style={styles.name} numberOfLines={1}>
              {automation.name}
            </Text>
            <Text style={[styles.pill, automation.enabled ? styles.pillOn : styles.pillOff]}>
              {automation.enabled ? "enabled" : "disabled"}
            </Text>
          </View>
          <Text style={styles.repo} numberOfLines={1}>
            {automation.repo ?? "No repository"}
          </Text>
          <Text style={styles.meta}>{describeTrigger(automation.trigger)}</Text>
        </View>
        <Switch
          value={automation.enabled}
          disabled={toggle.isPending}
          onValueChange={(enabled) => toggle.mutate(enabled)}
          accessibilityLabel={`Enabled: ${automation.name}`}
          trackColor={{ false: colors.secondary, true: colors.primary }}
        />
      </View>

      <Text style={styles.prompt} numberOfLines={2}>
        {promptPreview(automation.prompt)}
      </Text>
      {automation.nextRunAt !== null ? <Text style={styles.meta}>Next run {formatWhen(automation.nextRunAt)}</Text> : null}

      <View style={styles.actions}>
        <ActionButton label="Edit" onPress={onEdit} />
        <ActionButton label={showRuns ? "Hide runs" : "Recent runs"} onPress={() => setShowRuns(!showRuns)} />
        <ActionButton
          label="Remove"
          destructive
          disabled={remove.isPending}
          onPress={() =>
            Alert.alert("Remove automation?", `“${automation.name}” will stop running.`, [
              { text: "Cancel", style: "cancel" },
              { text: "Remove", style: "destructive", onPress: () => remove.mutate() },
            ])
          }
        />
      </View>

      <View style={styles.runNow}>
        {isGithub ? (
          <TextInput
            style={styles.pullRequestInput}
            value={pullRequest}
            onChangeText={setPullRequest}
            placeholder="Pull request #"
            placeholderTextColor={colors.mutedForeground}
            keyboardType="number-pad"
          />
        ) : null}
        <ActionButton
          label={run.isPending ? "Starting…" : "Run now"}
          disabled={run.isPending || (isGithub && !pullRequestValid)}
          onPress={() => run.mutate(isGithub ? { pullRequest: pullRequestNumber } : {})}
        />
      </View>

      {error ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{errorText(error)}</Text>
        </View>
      ) : null}
      {lastRun ? <RunLine run={lastRun} /> : null}

      {showRuns ? (
        <View style={styles.runs}>
          {runs.isPending ? <ActivityIndicator color={colors.primary} /> : null}
          {runs.error ? (
            <View style={styles.errorBox}>
              <Text style={styles.errorText}>{errorText(runs.error)}</Text>
            </View>
          ) : null}
          {runs.data?.length === 0 ? <Text style={styles.meta}>No runs yet.</Text> : null}
          {runs.data?.map((item) => (
            <RunLine key={item.id} run={item} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** One run: its status, reason, time and error; opens the run's thread when it started one. */
function RunLine({ run }: { run: AutomationRun }) {
  const { push } = useNavigation();
  const failed = run.status === "failed";
  const body = (
    <>
      <Text style={[styles.runStatus, { color: failed ? colors.destructive : colors.success }]}>
        {failed ? "Failed" : "Started"}
      </Text>
      <Text style={styles.meta}>
        {run.reason} · {formatWhen(run.firedAt)}
      </Text>
      {run.error ? <Text style={styles.runError}>{run.error}</Text> : null}
    </>
  );

  if (run.taskId === null) return <View style={styles.run}>{body}</View>;
  const taskId = run.taskId;
  return (
    <Pressable
      style={styles.run}
      onPress={() => push({ name: "thread", taskId })}
      accessibilityRole="button"
      accessibilityLabel="Open thread"
    >
      {body}
      <Text style={styles.link}>Open thread ›</Text>
    </Pressable>
  );
}

function ActionButton({
  label,
  onPress,
  disabled = false,
  destructive = false,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  destructive?: boolean;
}) {
  return (
    <Pressable
      style={[styles.action, disabled && styles.disabled]}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
    >
      <Text style={[styles.actionText, destructive && styles.destructiveText]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  content: {
    padding: spacing.lg,
    gap: spacing.md,
  },
  subtitle: {
    color: colors.mutedForeground,
    fontSize: 13,
  },
  emptyTitle: {
    color: colors.foreground,
    fontSize: 15,
    fontWeight: "600",
  },
  primaryButton: {
    alignSelf: "flex-start",
    backgroundColor: colors.primary,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm + 2,
    borderRadius: radius.md,
  },
  primaryText: {
    color: colors.primaryForeground,
    fontSize: 14,
    fontWeight: "600",
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.md,
  },
  titleBlock: {
    flex: 1,
    gap: 2,
  },
  titleLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  name: {
    flexShrink: 1,
    color: colors.foreground,
    fontSize: 15,
    fontWeight: "600",
  },
  pill: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.sm,
    fontSize: 11,
    fontWeight: "600",
    overflow: "hidden",
  },
  pillOn: {
    backgroundColor: colors.success + "22",
    color: colors.success,
  },
  pillOff: {
    backgroundColor: colors.muted,
    color: colors.mutedForeground,
  },
  repo: {
    color: colors.mutedForeground,
    fontSize: 12,
    fontFamily: "monospace",
  },
  meta: {
    color: colors.mutedForeground,
    fontSize: 12,
  },
  prompt: {
    color: colors.mutedForeground,
    fontSize: 13,
  },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: spacing.sm,
  },
  action: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  actionText: {
    color: colors.primary,
    fontSize: 13,
    fontWeight: "500",
  },
  destructiveText: {
    color: colors.destructive,
  },
  disabled: {
    opacity: 0.4,
  },
  runNow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  pullRequestInput: {
    flex: 1,
    backgroundColor: colors.secondary,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    color: colors.foreground,
    fontSize: 13,
  },
  errorBox: {
    backgroundColor: colors.destructive + "18",
    padding: spacing.md,
    borderRadius: radius.md,
  },
  errorText: {
    color: colors.destructive,
    fontSize: 13,
  },
  runs: {
    gap: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    paddingTop: spacing.sm,
  },
  run: {
    gap: 2,
    paddingVertical: spacing.xs,
  },
  runStatus: {
    fontSize: 13,
    fontWeight: "600",
  },
  runError: {
    color: colors.destructive,
    fontSize: 12,
  },
  link: {
    color: colors.primary,
    fontSize: 12,
    fontWeight: "500",
  },
});
