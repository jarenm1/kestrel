import React, { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type AgentEffort,
  type AgentModel,
  modelInfo,
  type TextGenerationSettings,
  type ThreadSettings,
} from "@cloudagents/protocol";
import { Check, RotateCcw } from "lucide-react-native";
import type { ApiClient } from "@/api/client";
import { createQueries, queryClient } from "@/api/queries";
import { effortOptions, ModelPicker, ThinkingPicker } from "@/components/ModelPicker";
import { SettingsPage } from "@/components/SettingsPage";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Textarea } from "@/components/ui/Input";
import { Switch } from "@/components/ui/Switch";
import { useApiClient } from "@/hooks/useApiClient";
import { useShownModels } from "@/hooks/useShownModels";
import { offeredModelSections } from "@cloudagents/composer/models";
import { errorText } from "@/lib/format";
import { pendingSaves, trackSave, trackSaveQueue } from "@/lib/pendingSaves";
import { createSaveQueue } from "@/lib/saveQueue";
import { colors, radius, spacing } from "@/theme";

const STREAMING_OPTIONS = [
  {
    value: "paragraph",
    label: "Show finished paragraphs",
    desc: "Each paragraph or code block appears as soon as it is complete.",
  },
  {
    value: "turn",
    label: "Wait for the full response",
    desc: "Text appears once the agent finishes its turn.",
  },
] as const;

const TEXT_GENERATION_DESC =
  "Choose how short generated text is written, how new threads are titled, and how assistant prose is buffered.";

/**
 * Thread preferences on the active box: generated text (model, thinking, title instructions, streaming) and how
 * threads run (usage-limit resume). Reads and writes are pinned to the box the screen was opened for: switching boxes
 * mounts a fresh form and a write already in flight still lands on the box the user made it on.
 */
export function ThreadsSettingsScreen() {
  const { api } = useApiClient();
  return (
    <SettingsPage
      title="Threads"
      description="How new threads are named and streamed, and what happens when a thread hits a usage limit."
    >
      <View style={styles.body}>
        <ThreadsSettingsForBox key={api.boxScope} api={api} />
      </View>
    </SettingsPage>
  );
}

function ThreadsSettingsForBox({ api }: { api: ApiClient }) {
  return (
    <>
      <TextGenerationCard api={api} />
      <UsageLimitsCard api={api} />
    </>
  );
}

/**
 * Model, thinking level and streaming save immediately; title instructions save on blur. Writes are queued so one PUT
 * is in flight at a time, and the queue is pinned to the client it was opened with. Leaving the screen only suppresses
 * form updates: every accepted change still reaches its box and updates that box's cache, so navigation cannot lose a
 * pick.
 */
function TextGenerationCard({ api }: { api: ApiClient }) {
  const queries = useMemo(() => createQueries(api), [api]);
  const client = useQueryClient();
  const connections = useQuery(queries.connections());
  const capabilities = useQuery(queries.capabilities());
  const settings = useQuery(queries.textGenerationSettings());
  const shown = useShownModels();
  const [form, setForm] = useState<TextGenerationSettings>();
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveError, setSaveError] = useState<unknown>();
  const savedInstructions = useRef("");
  const hydrated = useRef(false);
  const disposed = useRef(false);
  const cacheKey = queries.textGenerationSettings().queryKey;
  // A form reopened for this box waits for a just-closed form's writes before hydrating.
  const [pendingLoaded, setPendingLoaded] = useState(() => pendingSaves(api.boxScope) === undefined);
  useEffect(() => {
    const pending = pendingSaves(api.boxScope);
    if (pending === undefined) {
      setPendingLoaded(true);
      return;
    }
    let active = true;
    void pending.then(() => {
      if (active) setPendingLoaded(true);
    });
    return () => {
      active = false;
    };
  }, [api.boxScope]);
  // One PUT at a time, each snapshot pinned to the box this form was opened on; leaving the screen keeps draining it.
  const queue = useMemo(
    () =>
      createSaveQueue<TextGenerationSettings>((next) => api.saveTextGenerationSettings(next), {
        onSaved: (saved, snapshot, pending) => {
          client.setQueryData(cacheKey, saved);
          if (disposed.current) return;
          savedInstructions.current = snapshot.threadTitleInstructions;
          setSaveState(pending ? "saving" : "saved");
        },
        onError: (error, pending) => {
          if (disposed.current || pending) return;
          setSaveError(error);
          setSaveState("error");
        },
      }),
    [api, client, cacheKey]
  );

  // Hydrate once from the snapshot this mount's own GET settled on, never from cached data a fresh GET may still be
  // replacing. After that, later cache changes (including our own successful saves) must not overwrite user edits.
  useEffect(() => {
    if (!pendingLoaded || hydrated.current || settings.data === undefined || !settings.isFetchedAfterMount) return;
    hydrated.current = true;
    setForm(settings.data);
    savedInstructions.current = settings.data.threadTitleInstructions;
  }, [pendingLoaded, settings.data, settings.isFetchedAfterMount]);

  // Navigating away stops form updates but lets the queue keep draining to the box it was captured for.
  useEffect(() => {
    disposed.current = false;
    return () => {
      disposed.current = true;
    };
  }, []);

  useEffect(() => {
    if (saveState !== "saved") return;
    const timer = setTimeout(() => setSaveState("idle"), 2000);
    return () => clearTimeout(timer);
  }, [saveState]);

  function persist(next: TextGenerationSettings) {
    if (!disposed.current) {
      setForm(next);
      setSaveError(undefined);
      setSaveState("saving");
    }
    queue.push(next);
    trackSaveQueue(api.boxScope, queue);
  }

  const modelSections = connections.data
    ? offeredModelSections(connections.data, shown, capabilities.data?.modelHarnesses)
    : null;
  const model = form ? (form.model === null ? undefined : modelInfo(form.model)) : undefined;
  const effort = form === undefined ? undefined : form.effort ?? model?.defaultEffort ?? model?.efforts[0];

  if (!form) {
    return (
      <>
        <View style={styles.sectionHeading}>
          <Text style={styles.sectionTitle}>Text generation</Text>
          <Text style={styles.description}>{TEXT_GENERATION_DESC}</Text>
        </View>
        {settings.error ? <Alert>{errorText(settings.error)}</Alert> : null}
        {!pendingLoaded || settings.isPending || settings.isFetching ? (
          <Text style={styles.muted}>Loading settings…</Text>
        ) : null}
      </>
    );
  }

  function update(patch: Partial<TextGenerationSettings>) {
    if (!form) return;
    persist({ ...form, ...patch });
  }

  function saveInstructions() {
    if (!form || !form.enabled) return;
    const value = form.threadTitleInstructions.trim();
    if (value !== savedInstructions.current) persist({ ...form, threadTitleInstructions: value });
  }

  return (
    <>
      <View style={styles.sectionHeading}>
        <View style={styles.headingRow}>
          <Text style={styles.sectionTitle}>Text generation</Text>
          <Switch
            accessibilityLabel="Enable text generation"
            value={form.enabled}
            onValueChange={(enabled) => update({ enabled })}
          />
        </View>
        <Text style={styles.description}>
          {form.enabled
            ? TEXT_GENERATION_DESC
            : "Off. Keep original prompt-based titles and token-by-token responses, without extra title-generation requests."}
        </Text>
      </View>
      {settings.error ? <Alert>{errorText(settings.error)}</Alert> : null}
      {connections.error ? <Alert>{errorText(connections.error)}</Alert> : null}

      {/* Fields stay populated while off; `pointerEvents` only blocks edits, matching the desktop's disabled fieldset. */}
      <View
        pointerEvents={form.enabled ? "auto" : "none"}
        accessibilityElementsHidden={!form.enabled}
        importantForAccessibility={form.enabled ? "auto" : "no-hide-descendants"}
        aria-hidden={!form.enabled}
        style={[styles.fields, !form.enabled && styles.fieldsDisabled]}
      >
        <Card style={styles.card}>
          <View style={styles.row}>
            <Text style={styles.label}>Model</Text>
            <View style={styles.rowControls}>
              <ModelPicker
                sections={modelSections}
                value={model}
                onChange={(id: AgentModel) => {
                  const next = modelInfo(id);
                  update({
                    model: id,
                    effort: form.effort !== null && next.efforts.includes(form.effort) ? form.effort : null,
                  });
                }}
                defaultLabel="Conversation model"
                disabled={!form.enabled}
              />
              {model !== undefined && model.efforts.length > 0 ? (
                <ThinkingPicker
                  value={effort}
                  options={effortOptions(model)}
                  onChange={(level: AgentEffort) => update({ effort: level })}
                />
              ) : null}
            </View>
          </View>
        </Card>

        <Card style={styles.card}>
          <View style={styles.headingRow}>
            <Text style={styles.label}>
              Thread title instructions
            </Text>
            {form.threadTitleInstructions !== "" ? (
              <Button
                variant="ghost"
                size="sm"
                icon={RotateCcw}
                onPress={() => persist({ ...form, threadTitleInstructions: "" })}
                accessibilityLabel="Reset thread title instructions"
              >
                Reset
              </Button>
            ) : null}
          </View>
          <Textarea
            accessibilityLabel="Thread title instructions"
            style={styles.textarea}
            value={form.threadTitleInstructions}
            placeholder="Keep titles to a few words. Lead with the main subject."
            onChangeText={(text) => setForm({ ...form, threadTitleInstructions: text })}
            onBlur={saveInstructions}
            editable={form.enabled}
          />
          <Text style={styles.helper}>
            Added to Kestrel's prompt when it automatically names a new thread. Leave blank to use the default
            instructions. Changes save when you leave the field.
          </Text>
        </Card>

        <Card style={styles.card}>
          <View>
            <Text style={styles.label}>Response streaming</Text>
            <Text style={styles.helper}>How assistant prose is buffered before it reaches the transcript.</Text>
          </View>
          <View style={styles.options}>
            {STREAMING_OPTIONS.map((option) => {
              const active = form.responseStreamingMode === option.value;
              return (
                <Pressable
                  key={option.value}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: active, disabled: !form.enabled }}
                  disabled={!form.enabled}
                  onPress={() => update({ responseStreamingMode: option.value })}
                  style={({ pressed }) => [styles.option, active && styles.optionActive, pressed && styles.optionPressed]}
                >
                  <View style={styles.optionTitleRow}>
                    <Text style={styles.optionTitle}>{option.label}</Text>
                    {active ? <Check size={16} color={colors.foreground} /> : null}
                  </View>
                  <Text style={styles.helper}>{option.desc}</Text>
                </Pressable>
              );
            })}
          </View>
        </Card>
      </View>

      {saveState === "error" ? <Alert>{errorText(saveError)}</Alert> : null}
      <Text
        style={styles.status}
        accessibilityRole="text"
        accessibilityLiveRegion="polite"
      >
        {saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved" : ""}
      </Text>
    </>
  );
}

/**
 * The active box's preferences for how threads run, pinned like text generation: switching boxes remounts the form.
 * The switch reflects the change immediately and rolls back if the box rejects it.
 */
function UsageLimitsCard({ api }: { api: ApiClient }) {
  const queries = useMemo(() => createQueries(api), [api]);
  const client = useQueryClient();
  const settings = useQuery(queries.threadSettings());
  const cacheKey = queries.threadSettings().queryKey;
  const save = useMutation({
    mutationFn: (next: ThreadSettings) => {
      const saving = api.saveThreadSettings(next);
      // A reopened screen's thread-settings GET must wait for this write, like the text-generation queue's.
      trackSave(api.boxScope, saving);
      return saving;
    },
    onMutate: async (next) => {
      await client.cancelQueries({ queryKey: cacheKey });
      const previous = client.getQueryData<ThreadSettings>(cacheKey);
      client.setQueryData(cacheKey, next);
      return { previous };
    },
    onError: (_error, _next, context) => {
      if (context?.previous !== undefined) client.setQueryData(cacheKey, context.previous);
    },
    onSuccess: (saved) => client.setQueryData(cacheKey, saved),
  });
  const enabled = settings.data?.autoResumeAfterUsageLimits ?? false;
  const disabled = settings.data === undefined || save.isPending;

  return (
    <>
      <View style={styles.sectionHeading}>
        <Text style={styles.sectionTitle}>Usage limits</Text>
      </View>
      <Card style={styles.card}>
        <View style={styles.row}>
          <View style={styles.rowText}>
            <Text style={styles.label}>Resume after usage limits</Text>
            <Text style={styles.helper}>
              Automatically resume threads when their usage limits reset. You can cancel auto-resume in each thread.
            </Text>
          </View>
          <Switch
            accessibilityLabel="Resume after usage limits"
            value={enabled}
            disabled={disabled}
            onValueChange={(next) => {
              if (settings.data === undefined) return;
              save.mutate({ ...settings.data, autoResumeAfterUsageLimits: next });
            }}
          />
        </View>
        {save.isPending ? <Text style={styles.helper}>Saving…</Text> : null}
      </Card>
      {settings.error ? <Alert>{errorText(settings.error)}</Alert> : null}
      {save.error ? <Alert>{errorText(save.error)}</Alert> : null}
    </>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: spacing.lg, paddingTop: spacing.lg, gap: spacing.lg },
  description: { color: colors.mutedForeground, fontSize: 14, lineHeight: 20 },
  sectionHeading: { gap: spacing.xs },
  sectionTitle: { color: colors.foreground, fontSize: 16, fontWeight: "600" },
  headingRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.md },
  fields: { gap: spacing.lg },
  fieldsDisabled: { opacity: 0.4 },
  card: { gap: spacing.md },
  row: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: spacing.md },
  rowText: { flex: 1, gap: 2 },
  rowControls: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: spacing.sm, flexShrink: 1 },
  label: { color: colors.foreground, fontSize: 15, fontWeight: "500", flexShrink: 1 },
  helper: { color: colors.mutedForeground, fontSize: 12, lineHeight: 17 },
  textarea: { minHeight: 84 },
  options: { gap: spacing.sm },
  option: {
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.white03,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    gap: 2,
  },
  optionActive: { borderColor: "rgba(255,255,255,0.32)", backgroundColor: colors.white06 },
  optionPressed: { backgroundColor: colors.white08 },
  optionTitleRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.sm },
  optionTitle: { color: colors.foreground, fontSize: 14, fontWeight: "500" },
  status: { color: colors.mutedForeground, fontSize: 14, minHeight: 20 },
  muted: { color: colors.mutedForeground },
});
