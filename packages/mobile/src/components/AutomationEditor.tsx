import React, { useMemo, useState } from "react";
import {
  FlatList,
  Modal,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown } from "lucide-react-native";
import {
  GithubAutomationEvent,
  type Automation,
  type AutomationTrigger,
  type CreateAutomationBody,
  type GithubRepo,
} from "@cloudagents/protocol";
import { createQueries, keys } from "@/api/queries";
import { ScreenHeader } from "@/components/ScreenHeader";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Input, Textarea } from "@/components/ui/Input";
import { StatusIcon } from "@/components/ui/StatusIcon";
import { useApiClient } from "@/hooks/useApiClient";
import { errorText } from "@/lib/format";
import { EVENT_LABELS, splitList } from "@/lib/automations";
import { colors, fonts, radius, spacing } from "@/theme";

export type AutomationEditorTarget =
  | { readonly kind: "create" }
  | { readonly kind: "edit"; readonly automation: Automation };

type TriggerKind = "schedule" | "github";

const switchTrack = { false: colors.secondary, true: colors.primary };

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
    <SafeAreaView style={styles.container}>
      <ScreenHeader title={target.kind === "edit" ? "Edit automation" : "New automation"} onBack={onClose} />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.description}>
          {kind === "schedule" ? "Runs on a schedule." : "Runs on pull request events."}
        </Text>

        <Field label="Name">
          <Input value={name} onChangeText={setName} />
        </Field>

        <Field label="Prompt">
          <Textarea style={styles.prompt} value={prompt} onChangeText={setPrompt} />
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
            <Pressable style={styles.select} onPress={() => setPickingRepo(true)} accessibilityRole="button">
              <Text style={[styles.selectText, repo === null && styles.placeholder]}>
                {repo ?? (kind === "schedule" ? "No repository" : "Select a repository")}
              </Text>
              <ChevronDown size={16} color={colors.mutedForeground} strokeWidth={2} />
            </Pressable>
          )}
        </Field>

        {kind === "schedule" ? (
          <>
            <Field label="Cron (minute hour day-of-month month day-of-week)">
              <Input
                style={styles.mono}
                value={cron}
                placeholder="0 9 * * 1-5"
                onChangeText={setCron}
                autoCapitalize="none"
                autoCorrect={false}
              />
            </Field>
            <Field label="Timezone">
              <Input
                value={timezone}
                placeholder="America/New_York"
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
                      {checked ? <Check size={12} color={colors.primaryForeground} strokeWidth={3} /> : null}
                    </View>
                    <Text style={styles.checkLabel}>{EVENT_LABELS[event]}</Text>
                  </Pressable>
                );
              })}
            </Field>
            <Field label="Reviewers (comma-separated; empty means any)">
              <Input
                value={reviewers}
                placeholder="alice, bob"
                onChangeText={setReviewers}
                autoCapitalize="none"
                autoCorrect={false}
              />
            </Field>
            <Field label="Base branches (comma-separated; empty means any)">
              <Input
                value={baseBranches}
                placeholder="main"
                onChangeText={setBaseBranches}
                autoCapitalize="none"
                autoCorrect={false}
              />
            </Field>
            <View style={styles.switchRow}>
              <Text style={styles.switchLabel}>Include draft pull requests</Text>
              <Switch
                value={includeDrafts}
                onValueChange={setIncludeDrafts}
                trackColor={switchTrack}
                thumbColor={includeDrafts ? colors.primaryForeground : colors.foreground}
                ios_backgroundColor={colors.secondary}
              />
            </View>
          </>
        )}

        {target.kind === "create" ? (
          <View style={styles.switchRow}>
            <Text style={styles.switchLabel}>Enabled</Text>
            <Switch
              value={enabled}
              onValueChange={setEnabled}
              trackColor={switchTrack}
              thumbColor={enabled ? colors.primaryForeground : colors.foreground}
              ios_backgroundColor={colors.secondary}
            />
          </View>
        ) : null}

        {save.error ? <Alert>{errorText(save.error)}</Alert> : null}

        <View style={styles.footer}>
          <Button variant="ghost" onPress={onClose}>
            Cancel
          </Button>
          <Button disabled={!canSave || save.isPending} onPress={() => save.mutate()}>
            {save.isPending ? "Saving…" : "Save"}
          </Button>
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
    </SafeAreaView>
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
      <SafeAreaView style={styles.container}>
        <ScreenHeader title="Repository" onBack={onClose} />
        {repos.isPending ? (
          <View style={styles.spinner}>
            <StatusIcon status="running" size={20} />
          </View>
        ) : null}
        {repos.error ? <Alert style={styles.inset}>{errorText(repos.error)}</Alert> : null}
        <FlatList
          data={repos.data ?? []}
          keyExtractor={(item: GithubRepo) => item.fullName}
          contentContainerStyle={styles.list}
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
            repos.isPending || repos.error ? undefined : (
              <Text style={styles.emptyText}>No repositories found.</Text>
            )
          }
        />
      </SafeAreaView>
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
      <View style={styles.optionText}>
        <Text style={styles.optionLabel} numberOfLines={1}>
          {label}
        </Text>
        {detail ? <Text style={styles.optionDetail}>{detail}</Text> : null}
      </View>
      {selected ? <Check size={16} color={colors.foreground} strokeWidth={2} /> : null}
    </Pressable>
  );
}

function Segment({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  return (
    <Button
      variant={selected ? "secondary" : "ghost"}
      active={selected}
      style={styles.segment}
      onPress={onPress}
      accessibilityLabel={label}
    >
      {label}
    </Button>
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

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  content: {
    padding: spacing.lg,
    gap: spacing.lg,
    paddingBottom: spacing.xxl,
  },
  description: {
    color: colors.mutedForeground,
    fontSize: 14,
    lineHeight: 20,
  },
  field: {
    gap: spacing.xs,
  },
  label: {
    color: colors.mutedForeground,
    fontSize: 12,
  },
  prompt: {
    minHeight: 120,
  },
  mono: {
    fontFamily: fonts.mono,
  },
  placeholder: {
    color: colors.mutedForeground,
  },
  readonly: {
    color: colors.foreground,
    fontSize: 14,
    paddingVertical: spacing.sm,
  },
  select: {
    minHeight: 40,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.sm,
    backgroundColor: colors.input,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  selectText: {
    flexShrink: 1,
    color: colors.foreground,
    fontSize: 15,
  },
  segmented: {
    flexDirection: "row",
    gap: spacing.sm,
  },
  segment: {
    flex: 1,
  },
  checkRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    minHeight: 36,
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
  checkLabel: {
    color: colors.foreground,
    fontSize: 14,
  },
  switchRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md,
    minHeight: 36,
  },
  switchLabel: {
    flexShrink: 1,
    color: colors.foreground,
    fontSize: 14,
  },
  footer: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: spacing.sm,
  },
  spinner: {
    alignItems: "center",
    paddingVertical: spacing.xl,
  },
  inset: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.lg,
  },
  list: {
    flexGrow: 1,
    paddingBottom: spacing.xxl,
  },
  emptyText: {
    padding: spacing.lg,
    color: colors.mutedForeground,
    fontSize: 14,
  },
  option: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    minHeight: 44,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  optionSelected: {
    backgroundColor: colors.white06,
  },
  optionText: {
    flex: 1,
    gap: 2,
  },
  optionLabel: {
    color: colors.foreground,
    fontSize: 14,
    fontFamily: fonts.mono,
  },
  optionDetail: {
    color: colors.mutedForeground,
    fontSize: 12,
  },
});
