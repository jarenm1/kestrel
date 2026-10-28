import React, { useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  GithubAutomationEvent,
  type Automation,
  type AutomationTrigger,
  type CreateAutomationBody,
  type GithubRepo,
} from "@cloudagents/protocol";
import { createQueries, keys } from "@/api/queries";
import { ScreenHeader } from "@/components/ScreenHeader";
import { useApiClient } from "@/hooks/useApiClient";
import { errorText } from "@/lib/format";
import { EVENT_LABELS, splitList } from "@/lib/automations";
import { colors, radius, spacing } from "@/theme";

export type AutomationEditorTarget =
  | { readonly kind: "create" }
  | { readonly kind: "edit"; readonly automation: Automation };

type TriggerKind = "schedule" | "github";

/**
 * Creates or edits an automation with the web dialog's fields and validation. Edit keeps the trigger kind and repo;
 * create also picks the trigger kind, repository and enabled state.
 */
export function AutomationEditor({ target, onClose }: { target: AutomationEditorTarget | null; onClose: () => void }) {
  return (
    <Modal visible={target !== null} animationType="slide" onRequestClose={onClose}>
      {target ? (
        <AutomationEditorForm
          key={target.kind === "edit" ? target.automation.id : "create"}
          target={target}
          onClose={onClose}
        />
      ) : null}
    </Modal>
  );
}

function AutomationEditorForm({ target, onClose }: { target: AutomationEditorTarget; onClose: () => void }) {
  const { api } = useApiClient();
  const queryClient = useQueryClient();
  const seed = target.kind === "edit" ? target.automation : null;
  const seedTrigger = seed?.trigger;

  const [name, setName] = useState(seed?.name ?? "");
  const [prompt, setPrompt] = useState(seed?.prompt ?? "");
  const [kind, setKind] = useState<TriggerKind>(seedTrigger?._tag ?? "schedule");
  const [cron, setCron] = useState(seedTrigger?._tag === "schedule" ? seedTrigger.cron : "");
  const [timezone, setTimezone] = useState(seedTrigger?._tag === "schedule" ? seedTrigger.timezone : "");
  const [events, setEvents] = useState<readonly GithubAutomationEvent[]>(
    seedTrigger?._tag === "github" ? seedTrigger.events : [],
  );
  const [reviewers, setReviewers] = useState(
    seedTrigger?._tag === "github" ? (seedTrigger.reviewers ?? []).join(", ") : "",
  );
  const [baseBranches, setBaseBranches] = useState(
    seedTrigger?._tag === "github" ? (seedTrigger.baseBranches ?? []).join(", ") : "",
  );
  const [includeDrafts, setIncludeDrafts] = useState(seedTrigger?._tag === "github" && seedTrigger.includeDrafts === true);
  const [repo, setRepo] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [pickingRepo, setPickingRepo] = useState(false);

  /** Throws (shown as the save error) when a GitHub automation has no event picked. */
  function buildTrigger(): AutomationTrigger {
    if (kind === "schedule") return { _tag: "schedule", cron: cron.trim(), timezone: timezone.trim() };
    const [first, ...rest] = events;
    if (first === undefined) throw new Error("Pick at least one pull request event.");
    return {
      _tag: "github",
      events: [first, ...rest],
      reviewers: splitList(reviewers),
      baseBranches: splitList(baseBranches),
      includeDrafts,
    };
  }

  const save = useMutation({
    mutationFn: (): Promise<Automation> => {
      if (target.kind === "edit") {
        return api.updateAutomation(target.automation.id, {
          name: name.trim(),
          prompt: prompt.trim(),
          trigger: buildTrigger(),
        });
      }
      const body: CreateAutomationBody = {
        name: name.trim(),
        prompt: prompt.trim(),
        trigger: buildTrigger(),
        enabled,
        ...(repo === null ? {} : { repo }),
      };
      return api.createAutomation(body);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.automations });
      onClose();
    },
  });

  function toggleEvent(event: GithubAutomationEvent) {
    const picked = events.includes(event);
    setEvents(GithubAutomationEvent.literals.filter((e) => (e === event ? !picked : events.includes(e))));
  }

  const repoRequired = target.kind === "create" && kind === "github";
  const triggerReady = kind === "schedule" ? cron.trim() !== "" && timezone.trim() !== "" : events.length > 0;
  const canSave = name.trim() !== "" && prompt.trim() !== "" && triggerReady && (!repoRequired || repo !== null);

  return (
    <View style={styles.container}>
      <ScreenHeader
        title={target.kind === "edit" ? "Edit automation" : "New automation"}
        onBack={onClose}
      />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.subtitle}>
          {kind === "schedule" ? "Runs on a schedule." : "Runs on pull request events."}
        </Text>

        <Field label="Name">
          <TextInput style={styles.input} value={name} onChangeText={setName} placeholderTextColor={colors.mutedForeground} />
        </Field>

        <Field label="Prompt">
          <TextInput
            style={[styles.input, styles.multiline]}
            value={prompt}
            onChangeText={setPrompt}
            multiline
            textAlignVertical="top"
            placeholderTextColor={colors.mutedForeground}
          />
        </Field>

        {target.kind === "create" ? (
          <Field label="Trigger">
            <View style={styles.segmented}>
              <Segment label="Schedule" selected={kind === "schedule"} onPress={() => setKind("schedule")} />
              <Segment label="Pull requests" selected={kind === "github"} onPress={() => setKind("github")} />
            </View>
          </Field>
        ) : null}

        <Field label="Repository">
          {target.kind === "edit" ? (
            <Text style={styles.readonly}>{target.automation.repo ?? "No repository"}</Text>
          ) : (
            <Pressable style={styles.input} onPress={() => setPickingRepo(true)} accessibilityRole="button">
              <Text style={repo === null ? styles.placeholder : styles.readonly}>
                {repo ?? (kind === "schedule" ? "No repository" : "Select a repository")}
              </Text>
            </Pressable>
          )}
        </Field>

        {kind === "schedule" ? (
          <>
            <Field label="Cron (minute hour day-of-month month day-of-week)">
              <TextInput
                style={[styles.input, styles.mono]}
                value={cron}
                placeholder="0 9 * * 1-5"
                placeholderTextColor={colors.mutedForeground}
                onChangeText={setCron}
                autoCapitalize="none"
                autoCorrect={false}
              />
            </Field>
            <Field label="Timezone">
              <TextInput
                style={styles.input}
                value={timezone}
                placeholder="America/New_York"
                placeholderTextColor={colors.mutedForeground}
                onChangeText={setTimezone}
                autoCapitalize="none"
                autoCorrect={false}
              />
            </Field>
          </>
        ) : (
          <>
            <Field label="Pull request events">
              {GithubAutomationEvent.literals.map((event) => {
                const checked = events.includes(event);
                return (
                  <Pressable
                    key={event}
                    style={styles.checkRow}
                    onPress={() => toggleEvent(event)}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked }}
                  >
                    <View style={[styles.checkbox, checked && styles.checkboxOn]}>
                      {checked ? <Text style={styles.checkMark}>✓</Text> : null}
                    </View>
                    <Text style={styles.checkLabel}>{EVENT_LABELS[event]}</Text>
                  </Pressable>
                );
              })}
            </Field>
            <Field label="Reviewers (comma-separated; empty means any)">
              <TextInput
                style={styles.input}
                value={reviewers}
                placeholder="alice, bob"
                placeholderTextColor={colors.mutedForeground}
                onChangeText={setReviewers}
                autoCapitalize="none"
                autoCorrect={false}
              />
            </Field>
            <Field label="Base branches (comma-separated; empty means any)">
              <TextInput
                style={styles.input}
                value={baseBranches}
                placeholder="main"
                placeholderTextColor={colors.mutedForeground}
                onChangeText={setBaseBranches}
                autoCapitalize="none"
                autoCorrect={false}
              />
            </Field>
            <View style={styles.switchRow}>
              <Text style={styles.switchLabel}>Include draft pull requests</Text>
              <Switch value={includeDrafts} onValueChange={setIncludeDrafts} trackColor={switchColors} />
            </View>
          </>
        )}

        {target.kind === "create" ? (
          <View style={styles.switchRow}>
            <Text style={styles.switchLabel}>Enabled</Text>
            <Switch value={enabled} onValueChange={setEnabled} trackColor={switchColors} />
          </View>
        ) : null}

        {save.error ? (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{errorText(save.error)}</Text>
          </View>
        ) : null}

        <View style={styles.footer}>
          <Pressable style={[styles.button, styles.ghostButton]} onPress={onClose} accessibilityRole="button">
            <Text style={styles.ghostText}>Cancel</Text>
          </Pressable>
          <Pressable
            style={[styles.button, styles.primaryButton, (!canSave || save.isPending) && styles.disabled]}
            disabled={!canSave || save.isPending}
            onPress={() => save.mutate()}
            accessibilityRole="button"
          >
            <Text style={styles.primaryText}>{save.isPending ? "Saving…" : "Save"}</Text>
          </Pressable>
        </View>
      </ScrollView>

      <RepoPicker
        visible={pickingRepo}
        selected={repo}
        allowNone={kind === "schedule"}
        onSelect={(picked) => {
          setRepo(picked);
          setPickingRepo(false);
        }}
        onClose={() => setPickingRepo(false)}
      />
    </View>
  );
}

function RepoPicker({
  visible,
  selected,
  allowNone,
  onSelect,
  onClose,
}: {
  visible: boolean;
  selected: string | null;
  allowNone: boolean;
  onSelect: (repo: string | null) => void;
  onClose: () => void;
}) {
  const { api } = useApiClient();
  const queries = useMemo(() => createQueries(api), [api]);
  const repos = useQuery({ ...queries.githubRepos(), enabled: visible });

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.container}>
        <ScreenHeader title="Repository" onBack={onClose} />
        {repos.isPending ? <ActivityIndicator color={colors.primary} style={styles.spinner} /> : null}
        {repos.error ? (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{errorText(repos.error)}</Text>
          </View>
        ) : null}
        <FlatList
          data={repos.data ?? []}
          keyExtractor={(item: GithubRepo) => item.fullName}
          contentContainerStyle={styles.content}
          ListHeaderComponent={
            allowNone ? (
              <RepoOption label="No repository" selected={selected === null} onPress={() => onSelect(null)} />
            ) : undefined
          }
          renderItem={({ item }) => (
            <RepoOption
              label={item.fullName}
              detail={item.private ? "private" : undefined}
              selected={selected === item.fullName}
              onPress={() => onSelect(item.fullName)}
            />
          )}
          ListEmptyComponent={
            repos.isPending || repos.error ? undefined : <Text style={styles.subtitle}>No repositories found.</Text>
          }
        />
      </View>
    </Modal>
  );
}

function RepoOption({
  label,
  detail,
  selected,
  onPress,
}: {
  label: string;
  detail?: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      style={[styles.option, selected && styles.optionSelected]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected }}
    >
      <Text style={styles.optionLabel}>{label}</Text>
      {detail ? <Text style={styles.optionDetail}>{detail}</Text> : null}
    </Pressable>
  );
}

function Segment({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  return (
    <Pressable
      style={[styles.segment, selected && styles.segmentSelected]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected }}
    >
      <Text style={[styles.segmentText, selected && styles.segmentTextSelected]}>{label}</Text>
    </Pressable>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      {children}
    </View>
  );
}

const switchColors = { false: colors.secondary, true: colors.primary };

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
  field: {
    gap: spacing.xs,
  },
  label: {
    color: colors.mutedForeground,
    fontSize: 12,
  },
  input: {
    backgroundColor: colors.secondary,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    color: colors.foreground,
    fontSize: 14,
  },
  multiline: {
    minHeight: 120,
  },
  mono: {
    fontFamily: "monospace",
  },
  placeholder: {
    color: colors.mutedForeground,
    fontSize: 14,
  },
  readonly: {
    color: colors.foreground,
    fontSize: 14,
  },
  segmented: {
    flexDirection: "row",
    gap: spacing.sm,
  },
  segment: {
    flex: 1,
    alignItems: "center",
    paddingVertical: spacing.sm + 2,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.secondary,
  },
  segmentSelected: {
    borderColor: colors.primary,
    backgroundColor: colors.accent,
  },
  segmentText: {
    color: colors.mutedForeground,
    fontSize: 13,
    fontWeight: "600",
  },
  segmentTextSelected: {
    color: colors.foreground,
  },
  checkRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingVertical: spacing.xs,
  },
  checkbox: {
    width: 18,
    height: 18,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  checkboxOn: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  checkMark: {
    color: colors.primaryForeground,
    fontSize: 12,
    fontWeight: "700",
  },
  checkLabel: {
    color: colors.foreground,
    fontSize: 14,
  },
  switchRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md,
  },
  switchLabel: {
    color: colors.foreground,
    fontSize: 14,
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
  footer: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  button: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm + 2,
    borderRadius: radius.md,
  },
  ghostButton: {
    borderWidth: 1,
    borderColor: colors.border,
  },
  ghostText: {
    color: colors.foreground,
    fontSize: 14,
  },
  primaryButton: {
    backgroundColor: colors.primary,
  },
  primaryText: {
    color: colors.primaryForeground,
    fontSize: 14,
    fontWeight: "600",
  },
  disabled: {
    opacity: 0.4,
  },
  spinner: {
    marginTop: spacing.lg,
  },
  option: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  optionSelected: {
    backgroundColor: colors.accent,
  },
  optionLabel: {
    color: colors.foreground,
    fontSize: 14,
    fontFamily: "monospace",
  },
  optionDetail: {
    color: colors.mutedForeground,
    fontSize: 12,
  },
});
