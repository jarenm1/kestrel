import React, { useMemo, useState } from "react";
import {
  Alert as NativeAlert,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown } from "lucide-react-native";
import {
  GithubAutomationEvent,
  connectedModelProviders,
  modelInfo,
  type AgentModel,
  type Automation,
  type AutomationTrigger,
  type CreateAutomationBody,
  type CreatedAutomation,
  type GithubRepo,
  type WebhookEndpoint,
} from "@cloudagents/protocol";
import { createQueries, keys } from "@/api/queries";
import { useAuth } from "@/auth/AuthContext";
import { ScreenHeader } from "@/components/ScreenHeader";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Input, Textarea } from "@/components/ui/Input";
import { StatusIcon } from "@/components/ui/StatusIcon";
import { useApiClient } from "@/hooks/useApiClient";
import { useShownModels } from "@/hooks/useShownModels";
import { errorText } from "@/lib/format";
import { DELIVERY_LABELS, EVENT_LABELS, ON_UNAVAILABLE_LABELS, formatWhen, splitList } from "@/lib/automations";
import { colors, fonts, radius, spacing } from "@/theme";

export type AutomationEditorTarget =
  | { readonly kind: "create" }
  | { readonly kind: "edit"; readonly automation: Automation };

type TriggerKind = "schedule" | "github" | "webhook";

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
  const [model, setModel] = useState<AgentModel | null>(seed?.model ?? null);
  const [pickingModel, setPickingModel] = useState(false);
  const queries = useMemo(() => createQueries(api), [api]);
  const connections = useQuery(queries.connections());
  const shown = useShownModels();
  const providers = connectedModelProviders(connections.data ?? []);
  const models = providers.flatMap((provider) => shown[provider.id]);
  const selectedModel = model === null ? null : modelInfo(model);
  const { activeBoxId, boxes } = useAuth();
  const unavailable = activeBoxId !== null;
  const [kind, setKind] = useState<TriggerKind>(seedTrigger?._tag ?? (unavailable ? "webhook" : "schedule"));
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
  const [webhookBoxId, setWebhookBoxId] = useState<string | null>(seed?.webhook?.preferredBoxId ?? null);
  const [onUnavailable, setOnUnavailable] = useState<WebhookEndpoint["onUnavailable"]>(
    seed?.webhook?.onUnavailable ?? "retry",
  );
  const [pickingBox, setPickingBox] = useState(false);
  const [createdWebhook, setCreatedWebhook] = useState<{ url: string; secret: string } | null>(null);
  const webhookBody = kind === "webhook" ? { webhook: { preferredBoxId: webhookBoxId, onUnavailable } } : {};
  const boxLabel =
    webhookBoxId === null ? "Kestrel's box" : (boxes.find((box) => box.id === webhookBoxId)?.name ?? "Unavailable box");

  /** Throws (shown as the save error) when a GitHub automation has no event picked. */
  function buildTrigger(): AutomationTrigger {
    if (kind === "schedule") return { _tag: "schedule", cron: cron.trim(), timezone: timezone.trim() };
    if (kind === "webhook") return { _tag: "webhook" };
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
    mutationFn: (): Promise<Automation | CreatedAutomation> => {
      if (target.kind === "edit") {
        return api.updateAutomation(target.automation.id, {
          name: name.trim(),
          prompt: prompt.trim(),
          model,
          trigger: buildTrigger(),
          ...webhookBody,
        });
      }
      const body: CreateAutomationBody = {
        name: name.trim(),
        prompt: prompt.trim(),
        model,
        trigger: buildTrigger(),
        enabled,
        ...(repo === null || kind === "webhook" ? {} : { repo }),
        ...webhookBody,
      };
      return api.createAutomation(body);
    },
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: keys.automations });
      if ("webhookSecret" in saved && saved.webhookSecret !== null && saved.webhook !== null) {
        setCreatedWebhook({ url: saved.webhook.url, secret: saved.webhookSecret });
        return;
      }
      onClose();
    },
  });

  function toggleEvent(event: GithubAutomationEvent) {
    const picked = events.includes(event);
    setEvents(GithubAutomationEvent.literals.filter((e) => (e === event ? !picked : events.includes(e))));
  }

  const repoRequired = target.kind === "create" && kind === "github";
  const triggerReady =
    kind === "schedule"
      ? cron.trim() !== "" && timezone.trim() !== ""
      : kind === "github"
        ? events.length > 0
        : true;
  const canSave = name.trim() !== "" && prompt.trim() !== "" && triggerReady && (!repoRequired || repo !== null);

  if (createdWebhook !== null) {
    return (
      <SafeAreaView style={styles.container}>
        <ScreenHeader title="Webhook ready" onBack={onClose} />
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={styles.description}>
            Copy the secret now. It is shown once; rotate it later from the automation to get a new one.
          </Text>
          <Card style={styles.section}>
            <Field label="Webhook URL">
              <Text selectable style={styles.monoText}>
                {createdWebhook.url}
              </Text>
            </Field>
            <Field label="Secret (shown once)">
              <Text selectable style={styles.monoText}>
                {createdWebhook.secret}
              </Text>
              <Text style={styles.hint}>
                Send it as Authorization: Bearer, or sign the body with HMAC-SHA256 and send X-Kestrel-Signature: sha256=…
              </Text>
            </Field>
          </Card>
          <Button onPress={onClose}>Done</Button>
        </ScrollView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <ScreenHeader title={target.kind === "edit" ? "Edit automation" : "New automation"} onBack={onClose} />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.description}>
          {kind === "schedule"
            ? "Runs on a schedule."
            : kind === "github"
              ? "Runs on pull request events."
              : "Runs when a request arrives at its webhook URL."}
        </Text>

        <Field label="Name">
          <Input value={name} onChangeText={setName} />
        </Field>

        <Field label="Prompt">
          <Textarea style={styles.prompt} value={prompt} onChangeText={setPrompt} />
        </Field>
        <Field label="Model">
          <Pressable style={styles.select} onPress={() => setPickingModel(true)} accessibilityRole="button">
            <Text style={styles.selectText}>{selectedModel?.name ?? "Default (box model)"}</Text>
            <ChevronDown size={16} color={colors.mutedForeground} strokeWidth={2} />
          </Pressable>
        </Field>

        {target.kind === "create" ? (
          <Field label="Trigger">
            <View style={styles.segmented}>
              <Segment
                label="Schedule"
                selected={kind === "schedule"}
                disabled={unavailable}
                onPress={() => setKind("schedule")}
              />
              <Segment
                label="Pull requests"
                selected={kind === "github"}
                disabled={unavailable}
                onPress={() => setKind("github")}
              />
              <Segment label="Webhook" selected={kind === "webhook"} onPress={() => setKind("webhook")} />
            </View>
          </Field>
        ) : null}

        {kind !== "webhook" ? (
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
        ) : null}

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
        ) : kind === "github" ? (
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
        ) : (
          <>
            <Field label="Box">
              <Pressable style={styles.select} onPress={() => setPickingBox(true)} accessibilityRole="button">
                <Text style={styles.selectText}>{boxLabel}</Text>
                <ChevronDown size={16} color={colors.mutedForeground} strokeWidth={2} />
              </Pressable>
            </Field>
            <Field label="If that box is unavailable">
              {(["retry", "fail"] as const).map((policy) => (
                <Pressable
                  key={policy}
                  style={styles.checkRow}
                  onPress={() => setOnUnavailable(policy)}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: onUnavailable === policy }}
                >
                  <View style={[styles.checkbox, onUnavailable === policy && styles.checkboxOn]}>
                    {onUnavailable === policy ? (
                      <Check size={12} color={colors.primaryForeground} strokeWidth={3} />
                    ) : null}
                  </View>
                  <Text style={styles.checkLabel}>{ON_UNAVAILABLE_LABELS[policy]}</Text>
                </Pressable>
              ))}
              <Text style={styles.hint}>
                Deliveries stay on the box you pick. Sending to another box as a fallback is not available yet.
              </Text>
            </Field>
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

        {target.kind === "edit" && target.automation.webhook ? (
          <WebhookDetails automationId={target.automation.id} url={target.automation.webhook.url} />
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
      <Modal visible={pickingModel} animationType="slide" onRequestClose={() => setPickingModel(false)}>
        <SafeAreaView style={styles.container}>
          <ScreenHeader title="Model" onBack={() => setPickingModel(false)} />
          <ScrollView contentContainerStyle={styles.list}>
            <RepoOption
              label="Default (box model)"
              selected={model === null}
              onPress={() => { setModel(null); setPickingModel(false); }}
            />
            {selectedModel !== null && !models.some((candidate) => candidate.id === model) ? (
              <RepoOption label={selectedModel.name} detail="Saved model" selected onPress={() => setPickingModel(false)} />
            ) : null}
            {providers.map((provider) => (
              <React.Fragment key={provider.id}>
                <Text style={styles.label}>{provider.name}</Text>
                {shown[provider.id].map((candidate) => (
                  <RepoOption
                    key={candidate.id}
                    label={candidate.name}
                    selected={candidate.id === model}
                    onPress={() => { setModel(candidate.id); setPickingModel(false); }}
                  />
                ))}
              </React.Fragment>
            ))}
            {connections.isPending ? <Text style={styles.emptyText}>Loading models…</Text> : null}
            {connections.error ? <Alert>{errorText(connections.error)}</Alert> : null}
            {connections.isSuccess && providers.length === 0 ? (
              <Text style={styles.emptyText}>Connect Anthropic or OpenAI to choose a model.</Text>
            ) : null}
          </ScrollView>
        </SafeAreaView>
      </Modal>
      <Modal visible={pickingBox} animationType="slide" onRequestClose={() => setPickingBox(false)}>
        <SafeAreaView style={styles.container}>
          <ScreenHeader title="Box" onBack={() => setPickingBox(false)} />
          <ScrollView contentContainerStyle={styles.list}>
            <RepoOption
              label="Kestrel's box"
              selected={webhookBoxId === null}
              onPress={() => { setWebhookBoxId(null); setPickingBox(false); }}
            />
            {boxes.map((box) => (
              <RepoOption
                key={box.id}
                label={box.name}
                selected={box.id === webhookBoxId}
                onPress={() => { setWebhookBoxId(box.id); setPickingBox(false); }}
              />
            ))}
          </ScrollView>
        </SafeAreaView>
      </Modal>
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

function Segment({
  label,
  selected,
  disabled,
  onPress,
}: {
  label: string;
  selected: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Button
      variant={selected ? "secondary" : "ghost"}
      active={selected}
      disabled={disabled}
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

/** Endpoint URL, one-time secret rotation and recent deliveries for an existing webhook automation. */
function WebhookDetails({ automationId, url }: { automationId: string; url: string }) {
  const { api } = useApiClient();
  const queries = useMemo(() => createQueries(api), [api]);
  const deliveries = useQuery(queries.automationDeliveries(automationId));
  const [secret, setSecret] = useState<string | null>(null);
  const rotate = useMutation({
    mutationFn: () => api.rotateAutomationWebhook(automationId),
    onSuccess: (rotated) => setSecret(rotated.secret),
  });

  function confirmRotate() {
    NativeAlert.alert("Rotate webhook secret?", "The current secret stops working immediately.", [
      { text: "Cancel", style: "cancel" },
      { text: "Rotate", style: "destructive", onPress: () => rotate.mutate() },
    ]);
  }

  return (
    <Card style={styles.section}>
      <Field label="Webhook URL">
        <Text selectable style={styles.monoText}>
          {url}
        </Text>
      </Field>
      {secret === null ? (
        <Button variant="secondary" disabled={rotate.isPending} onPress={confirmRotate}>
          {rotate.isPending ? "Rotating…" : "Rotate secret"}
        </Button>
      ) : (
        <Field label="New secret (shown once)">
          <Text selectable style={styles.monoText}>
            {secret}
          </Text>
          <Text style={styles.hint}>
            Send it as Authorization: Bearer, or sign the body with HMAC-SHA256 and send X-Kestrel-Signature: sha256=…
            The old secret no longer works.
          </Text>
          <Button variant="ghost" onPress={() => setSecret(null)}>
            Done
          </Button>
        </Field>
      )}
      {rotate.error ? <Alert>{errorText(rotate.error)}</Alert> : null}
      <Field label="Recent deliveries">
        {deliveries.error ? <Alert>{errorText(deliveries.error)}</Alert> : null}
        {deliveries.isPending ? <Text style={styles.hint}>Loading…</Text> : null}
        {deliveries.data?.length === 0 ? <Text style={styles.hint}>No deliveries yet.</Text> : null}
        {deliveries.data?.map((delivery) => (
          <View key={delivery.id} style={styles.deliveryRow}>
            <Text style={styles.deliveryStatus}>
              {DELIVERY_LABELS[delivery.status]} · {formatWhen(delivery.receivedAt)}
            </Text>
            <Text style={styles.hint}>{delivery.reason}</Text>
            {delivery.error ? <Text style={styles.deliveryError}>{delivery.error}</Text> : null}
          </View>
        ))}
      </Field>
    </Card>
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
  hint: {
    color: colors.mutedForeground,
    fontSize: 12,
    lineHeight: 17,
  },
  monoText: {
    color: colors.foreground,
    fontFamily: fonts.mono,
    fontSize: 13,
  },
  section: {
    gap: spacing.md,
  },
  deliveryRow: {
    gap: 2,
    paddingVertical: spacing.xs,
  },
  deliveryStatus: {
    color: colors.foreground,
    fontSize: 14,
  },
  deliveryError: {
    color: colors.destructive,
    fontSize: 12,
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
