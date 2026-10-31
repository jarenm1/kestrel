import React, { useMemo, useState } from "react";
import { Alert as NativeAlert, Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Plus } from "lucide-react-native";
import type { Automation, AutomationRun, TriggerAutomationBody } from "@cloudagents/protocol";
import { createQueries, keys } from "@/api/queries";
import { useAuth } from "@/auth/AuthContext";
import { AutomationEditor, type AutomationEditorTarget } from "@/components/AutomationEditor";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { StatusIcon } from "@/components/ui/StatusIcon";
import { useApiClient } from "@/hooks/useApiClient";
import { useNavigation } from "@/nav/navigation";
import { errorText } from "@/lib/format";
import { describeTrigger, formatWhen, promptPreview } from "@/lib/automations";
import { colors, fonts, radius, spacing } from "@/theme";

const switchTrack = { false: colors.secondary, true: colors.primary };

/** Lists every automation; toggles, edits, removes and runs them, and shows each one's recent runs. */
export function AutomationsScreen() {
  const { api } = useApiClient();
  const { activeBoxId } = useAuth();
  const unavailable = activeBoxId !== null;
  const queries = useMemo(() => createQueries(api), [api]);
  const automations = useQuery(queries.automations());
  const [editing, setEditing] = useState<AutomationEditorTarget | null>(null);
  const rows = automations.data ?? [];

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.heading}>
          <Text style={styles.title}>Automations</Text>
          <Text style={styles.subtitle}>Tasks the agent starts on a schedule or when a pull request changes.</Text>
        </View>
        {unavailable ? (
          <Alert variant="warning">
            {"Automations run on Kestrel's box; not yet available on your own box"}
          </Alert>
        ) : null}

        <Button
          icon={Plus}
          disabled={unavailable}
          onPress={() => setEditing({ kind: "create" })}
          style={styles.newButton}
        >
          New automation
        </Button>

        {automations.error ? <Alert>{errorText(automations.error)}</Alert> : null}
        {automations.isPending ? <StatusIcon status="running" /> : null}

        {automations.data && rows.length === 0 ? (
          <Card style={styles.empty}>
            <Text style={styles.emptyTitle}>No automations yet.</Text>
            <Text style={styles.emptyText}>
              Ask the agent in a thread to set one up, for example “review open pull requests every weekday at 9am”,
              and it will appear here.
            </Text>
          </Card>
        ) : null}

        {rows.length > 0 ? (
          <Card style={styles.list}>
            {rows.map((automation, index) => (
              <AutomationRow
                key={automation.id}
                automation={automation}
                divided={index > 0}
                unavailable={unavailable}
                onEdit={() => setEditing({ kind: "edit", automation })}
              />
            ))}
          </Card>
        ) : null}
      </ScrollView>

      <AutomationEditor target={editing} onClose={() => setEditing(null)} />
    </View>
  );
}

function AutomationRow({
  automation,
  divided,
  unavailable,
  onEdit,
}: {
  automation: Automation;
  divided: boolean;
  unavailable: boolean;
  onEdit: () => void;
}) {
  const { api } = useApiClient();
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
    <View style={[styles.row, divided && styles.divided]}>
      <View style={styles.headerRow}>
        <View style={styles.titleBlock}>
          <View style={styles.titleLine}>
            <Text style={styles.name} numberOfLines={1}>
              {automation.name}
            </Text>
            <EnabledBadge enabled={automation.enabled} />
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
          trackColor={switchTrack}
          thumbColor={automation.enabled ? colors.primaryForeground : colors.foreground}
          ios_backgroundColor={colors.secondary}
          style={toggle.isPending ? styles.disabled : undefined}
        />
      </View>

      <Text style={styles.prompt} numberOfLines={2}>
        {promptPreview(automation.prompt)}
      </Text>

      <View style={styles.footer}>
        {automation.nextRunAt !== null ? (
          <Text style={styles.meta}>Next run {formatWhen(automation.nextRunAt)}</Text>
        ) : null}
        <View style={styles.actions}>
          <Button variant="ghost" size="sm" onPress={onEdit} hitSlop={6}>
            Edit
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onPress={() => setShowRuns(!showRuns)}
            hitSlop={6}
          >
            {showRuns ? "Hide runs" : "Recent runs"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={remove.isPending}
            onPress={() =>
              NativeAlert.alert("Remove automation?", `“${automation.name}” will stop running.`, [
                { text: "Cancel", style: "cancel" },
                { text: "Remove", style: "destructive", onPress: () => remove.mutate() },
              ])
            }
            hitSlop={6}
          >
            Remove
          </Button>
        </View>
      </View>

      <View style={styles.runNow}>
        {isGithub ? (
          <Input
            style={styles.pullRequestInput}
            value={pullRequest}
            onChangeText={setPullRequest}
            placeholder="Pull request #"
            keyboardType="number-pad"
          />
        ) : null}
        <Button
          variant="soft"
          disabled={unavailable || run.isPending || (isGithub && !pullRequestValid)}
          onPress={() => run.mutate(isGithub ? { pullRequest: pullRequestNumber } : {})}
        >
          {run.isPending ? "Starting…" : "Run now"}
        </Button>
      </View>

      {error ? <Alert>{errorText(error)}</Alert> : null}
      {lastRun ? <RunLine run={lastRun} /> : null}

      {showRuns ? (
        <View style={styles.runs}>
          {runs.isPending ? <StatusIcon status="running" /> : null}
          {runs.error ? <Alert>{errorText(runs.error)}</Alert> : null}
          {runs.data?.length === 0 ? <Text style={styles.meta}>No runs yet.</Text> : null}
          {runs.data?.map((item) => (
            <RunLine key={item.id} run={item} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** Web-style enabled/disabled pill: a success tint with a dot when enabled, neutral when disabled. */
function EnabledBadge({ enabled }: { enabled: boolean }) {
  const tone = enabled ? colors.success : colors.mutedForeground;
  return (
    <View style={[styles.badge, enabled ? styles.badgeOn : styles.badgeOff]}>
      {enabled ? <View style={[styles.badgeDot, { backgroundColor: tone }]} /> : null}
      <Text style={[styles.badgeText, { color: tone }]}>{enabled ? "enabled" : "disabled"}</Text>
    </View>
  );
}

/** One run: its status, reason, time and error; opens the run's thread when it started one. */
function RunLine({ run }: { run: AutomationRun }) {
  const { push } = useNavigation();
  const failed = run.status === "failed";
  const body = (
    <>
      <StatusIcon status={failed ? "failed" : "succeeded"} />
      <View style={styles.runBody}>
        <Text style={styles.runStatus}>{failed ? "Failed" : "Started"}</Text>
        <Text style={styles.meta}>
          {run.reason} · {formatWhen(run.firedAt)}
        </Text>
        {run.error ? <Text style={styles.runError}>{run.error}</Text> : null}
        {run.taskId !== null ? (
          <View style={styles.openLink}>
            <Text style={styles.link}>Open thread</Text>
            <ChevronRight size={14} color={colors.primary} strokeWidth={2} />
          </View>
        ) : null}
      </View>
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
    gap: spacing.lg,
  },
  heading: {
    gap: spacing.xs,
  },
  title: {
    color: colors.foreground,
    fontSize: 20,
    fontWeight: "600",
    letterSpacing: -0.3,
  },
  subtitle: {
    color: colors.mutedForeground,
    fontSize: 14,
    lineHeight: 20,
  },
  newButton: {
    alignSelf: "flex-start",
  },
  empty: {
    alignItems: "center",
    gap: spacing.sm,
    paddingVertical: 40,
  },
  emptyTitle: {
    color: colors.foreground,
    fontSize: 14,
    fontWeight: "500",
  },
  emptyText: {
    color: colors.mutedForeground,
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center",
  },
  list: {
    paddingVertical: 0,
    paddingHorizontal: 0,
    gap: 0,
    overflow: "hidden",
  },
  row: {
    paddingHorizontal: 20,
    paddingVertical: 16,
    gap: 10,
  },
  divided: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.white08,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.lg,
  },
  titleBlock: {
    flex: 1,
    minWidth: 0,
    gap: 4,
  },
  titleLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  name: {
    flexShrink: 1,
    color: colors.foreground,
    fontSize: 14,
    fontWeight: "500",
  },
  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    flexShrink: 0,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.full,
  },
  badgeOn: {
    backgroundColor: colors.success + "1f",
  },
  badgeOff: {
    backgroundColor: colors.white06,
  },
  badgeDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: "500",
  },
  repo: {
    color: colors.mutedForeground,
    fontSize: 12,
    fontFamily: fonts.mono,
  },
  meta: {
    color: colors.mutedForeground,
    fontSize: 12,
  },
  prompt: {
    color: colors.mutedForeground,
    fontSize: 14,
    lineHeight: 20,
  },
  footer: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: spacing.sm,
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginLeft: "auto",
  },
  runNow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  pullRequestInput: {
    flex: 1,
  },
  runs: {
    gap: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    paddingTop: spacing.sm,
  },
  run: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.sm,
    paddingVertical: spacing.xs,
  },
  runBody: {
    flex: 1,
    gap: 2,
  },
  runStatus: {
    color: colors.foreground,
    fontSize: 13,
    fontWeight: "500",
  },
  runError: {
    color: colors.destructive,
    fontSize: 12,
  },
  openLink: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    marginTop: 2,
  },
  link: {
    color: colors.primary,
    fontSize: 12,
    fontWeight: "500",
  },
  disabled: {
    opacity: 0.5,
  },
});
