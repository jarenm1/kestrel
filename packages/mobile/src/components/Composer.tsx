import React, { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { ArrowUp, Check, ChevronDown, Settings2, Square } from "lucide-react-native";
import { Schema } from "effect";
import {
  composerViewOf,
  findGithubReferenceTrigger,
  type ComposerEditorView,
  type GithubReferenceKind,
} from "@cloudagents/composer/reference";
import {
  appCommandOf,
  matchAppCommand,
  withAppCommands,
  type AppCommand,
  type AppCommandHandlers,
} from "@cloudagents/composer/commands";
import Svg, { Circle } from "react-native-svg";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import {
  AgentModel,
  GithubRepoSlug,
  EFFORT_LABELS,
  EffortPick,
  connectedModelProviders,
  harnessCommandPrefix,
  Paths,
  resolveAgentChoice,
  type AgentEffort,
  type ContextUsage,
  type HarnessCommand,
  type Message,
  type ModelInfo,
  type ModelProvider,
  type ModelProviderInfo,
  type Run,
  type SendMessageBody,
  type SendMessageResponse,
} from "@cloudagents/protocol";
import { AttachmentImage } from "@/components/AttachmentImage";
import { createQueries } from "@/api/queries";
import { useApiClient } from "@/hooks/useApiClient";
import { useShownModels } from "@/hooks/useShownModels";
import { useStoredChoice } from "@/hooks/useStoredChoice";
import { useStoredDraft } from "@/hooks/useStoredDraft";
import { useNavigation } from "@/nav/navigation";
import { errorText } from "@/lib/format";
import { colors, fonts, radius, shadows, spacing } from "@/theme";
import { ContextBar } from "./ContextBar";
import { Markdown } from "./Markdown";
import { SlashCommands } from "./SlashCommands";
import ComposerEditor, { type DOMRef } from "./ComposerEditor";
import { GithubReferenceMenu } from "./GithubReferenceMenu";
import { ThinkingSlider } from "./ThinkingSlider";

// Match the desktop ring regardless of the model's number of supported levels.
const EFFORT_RING_FILL: Record<AgentEffort, number> = {
  none: 0,
  low: 25,
  medium: 50,
  high: 75,
  xhigh: 87.5,
  max: 100,
};

/** A connected provider and the models the user keeps in the picker for it. */
interface ModelSection {
  readonly provider: ModelProviderInfo;
  readonly models: readonly ModelInfo[];
}

/** The desktop thinking slider in a touch-sized sheet, shared by Expo and mobile web. */
function ThinkingPicker({
  value,
  options,
  onChange,
}: {
  value: AgentEffort | undefined;
  options: readonly { value: AgentEffort; label: string }[];
  onChange: (value: AgentEffort) => void;
}) {
  const [open, setOpen] = useState(false);
  const [width, setWidth] = useState(0);
  const index = Math.max(0, options.findIndex((option) => option.value === value));
  const selected = options[index]!;
  const ringFill = EFFORT_RING_FILL[selected.value];
  // Both input implementations reserve 16px at each end for the thumb.
  const offset = (stop: number) => 16 + Math.max(0, width - 32) * stop / (options.length - 1);
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        active={open}
        onPress={() => setOpen(true)}
        accessibilityLabel={`Thinking level: ${selected.label}`}
      >
        <Svg width={16} height={16} viewBox="0 0 24 24" fill="none" strokeWidth={3} accessibilityElementsHidden aria-hidden>
          <Circle cx={12} cy={12} r={9} stroke={colors.mutedForeground + "4d"} />
          {ringFill > 0 ? (
            <Circle
              cx={12} cy={12} r={9}
              stroke={colors.mutedForeground}
              strokeDasharray={`${2 * Math.PI * 9 * ringFill / 100} ${2 * Math.PI * 9}`}
              strokeLinecap="round"
              rotation={-90}
              origin="12, 12"
            />
          ) : null}
        </Svg>
        <Text style={styles.pillText}>{selected.label}</Text>
      </Button>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <View style={styles.modalRoot}>
          <Pressable style={styles.backdropFill} onPress={() => setOpen(false)} accessibilityLabel="Close thinking" accessibilityRole="button" />
          <View style={[styles.sheet, styles.thinkingSheet]}>
            <View style={styles.thinkingHeader}>
              <Text style={styles.thinkingLabel}>Thinking</Text>
              <Text style={styles.thinkingValue}>{selected.label}</Text>
            </View>
            <View style={styles.sliderHitArea} onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
              <View pointerEvents="none" style={styles.sliderTrack}>
                <View style={[styles.sliderFill, { width: offset(index) + 8 }]} />
                {options.map((option, stop) => (
                  <View key={option.label} style={[
                    styles.sliderStop,
                    { left: offset(stop) - 2, backgroundColor: stop <= index ? colors.primary + "99" : colors.mutedForeground + "66" },
                  ]} />
                ))}
                <View style={[styles.sliderThumb, { left: offset(index) - 12 }]} />
              </View>
              <ThinkingSlider
                value={index}
                max={options.length - 1}
                label={selected.label}
                onChange={(stop) => onChange(options[stop]!.value)}
              />
            </View>
            <View style={styles.thinkingEndpoints} aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
              <Text style={styles.thinkingLabel}>{options[0]!.label}</Text>
              <Text style={styles.thinkingLabel}>{options[options.length - 1]!.label}</Text>
            </View>
          </View>
        </View>
      </Modal>
    </>
  );
}

interface ModelPickerProps {
  /** Null while connections load. */
  readonly sections: readonly ModelSection[] | null;
  readonly value: ModelInfo | undefined;
  readonly onChange: (id: AgentModel) => void;
  readonly onManage: () => void;
}

/**
 * Model sheet: one group per connected provider, divided, listing the models the user keeps for it (Connections).
 * With nothing to offer the pill says so and goes straight to Connections.
 */
function ModelPicker({ sections, value, onChange, onManage }: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const nothingOffered = sections !== null && sections.length === 0;
  const shown = nothingOffered ? "No models" : (value?.name ?? "Model");
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        active={open}
        style={styles.modelPill}
        onPress={() => (nothingOffered ? onManage() : setOpen(true))}
        accessibilityLabel="Model"
      >
        <Text style={styles.pillText} numberOfLines={1}>{shown}</Text>
        <ChevronDown size={16} color={colors.mutedForeground} />
      </Button>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <View style={styles.modalRoot}>
          <Pressable style={styles.backdropFill} onPress={() => setOpen(false)} />
          <View style={[styles.sheet, styles.sheetTall]}>
            <Text style={styles.sheetLabel}>Model</Text>
            <ScrollView style={styles.sheetScroll}>
              {sections?.map((section, i) => (
                <React.Fragment key={section.provider.id}>
                  {i > 0 ? <View style={styles.divider} /> : null}
                  <Text style={styles.sectionHeader}>{section.provider.name}</Text>
                  {section.models.map((m) => (
                    <Pressable
                      key={m.id}
                      style={({ pressed }) => [styles.option, pressed && styles.optionPressed]}
                      onPress={() => {
                        onChange(m.id);
                        setOpen(false);
                      }}
                      accessibilityRole="radio"
                      accessibilityState={{ checked: m.id === value?.id }}
                    >
                      <View style={styles.optionCheck}>
                        {m.id === value?.id ? <Check size={16} color={colors.foreground} /> : null}
                      </View>
                      <Text style={styles.optionText}>{m.name}</Text>
                    </Pressable>
                  ))}
                </React.Fragment>
              ))}
            </ScrollView>
            <View style={styles.divider} />
            <Pressable
              style={styles.option}
              onPress={() => {
                setOpen(false);
                onManage();
              }}
              accessibilityRole="button"
            >
              <Settings2 size={16} color={colors.mutedForeground} />
              <Text style={styles.manageText}>Manage models</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </>
  );
}

interface ComposerProps {
  readonly onSend: (body: SendMessageBody) => Promise<SendMessageResponse | void>;
  readonly pending: boolean;
  readonly error: unknown;
  /** Shown as a stop button while the composer is empty and a run is active. */
  readonly onStop?: () => void;
  readonly stopping?: boolean;
  readonly placeholder?: string;
  readonly taskId?: string;
  readonly ask?: Message | undefined;
  readonly context?: ContextUsage | null | undefined;
  readonly activeRunId?: string;
  /** The run from `threadChoiceRun`: the pickers show its choice until a different one is picked. */
  readonly lastRun?: Pick<Run, "model" | "effort"> | undefined;
  readonly activeRunProvider?: ModelProvider;
  readonly repo?: string;
  readonly onRepoChange?: (repo: string) => void;
  readonly repos?: readonly string[];
  /** Hangs right under the message box, e.g. the new thread's repository, branch and box bar. */
  readonly below?: ReactNode;
}

/**
 * The agent's open question (`task_ask`) at the top of the box: its screenshot, the question, and its options.
 */
function AskPanel({
  ask,
  chosen,
  onChoose,
}: {
  ask: Message;
  chosen: number | undefined;
  onChoose: (index: number) => void;
}) {
  const attachments = ask.attachments ?? [];
  const options = ask.options ?? [];

  return (
    <View style={styles.askPanel}>
      {attachments.map((a) => (
        <AttachmentImage
          key={a.id}
          path={Paths.taskAttachment(ask.taskId, a.id)}
          style={styles.askImage}
          accessibilityLabel="Question attachment"
        />
      ))}
      <Markdown text={ask.text} />
      {options.length > 0 ? (
        <View style={styles.askOptions}>
          {options.map((option, i) => {
            const selected = chosen === i;
            return (
              <Pressable
                key={i}
                style={({ pressed }) => [
                  styles.askOption,
                  selected && styles.askOptionSelected,
                  pressed && styles.askOptionPressed,
                ]}
                onPress={() => onChoose(i)}
                accessibilityRole="radio"
                accessibilityState={{ selected }}
              >
                <View style={[styles.askBadge, selected && styles.askBadgeSelected]}>
                  {selected ? (
                    <Check size={12} color={colors.primaryForeground} strokeWidth={2.5} />
                  ) : (
                    <Text style={[styles.askBadgeText, selected && styles.askBadgeTextSelected]}>{i + 1}</Text>
                  )}
                </View>
                <Text style={styles.askOptionText}>{option}</Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

export function Composer({
  onSend,
  pending,
  error,
  onStop,
  stopping,
  placeholder,
  taskId,
  ask,
  context,
  activeRunId,
  activeRunProvider,
  lastRun,
  below,
  repo,
  onRepoChange,
  repos = [],
}: ComposerProps) {
  const { api } = useApiClient();
  const navigation = useNavigation();
  const queries = useMemo(() => createQueries(api), [api]);
  const connections = useQuery(queries.connections());
  const shown = useShownModels();
  const [text, setText, draftReady] = useStoredDraft(taskId ?? "new");
  // Only the initial persisted draft crosses into the DOM. Echoing edits back would let a delayed native
  // acknowledgement overwrite newer typing; subsequent edits and the successful-send clear stay inside the DOM.
  const initialDraft = useRef<string | undefined>(undefined);
  if (draftReady && initialDraft.current === undefined) initialDraft.current = text;
  const [view, setView] = useState<ComposerEditorView>(() => composerViewOf(""));
  const [focused, setFocused] = useState(false);
  const editor = useRef<DOMRef>(null);
  const [dismissed, setDismissed] = useState(false);
  const [activeReferenceIndex, setActiveReferenceIndex] = useState(0);
  const [activeCommandIndex, setActiveCommandIndex] = useState(0);
  const [pickedRepo, setPickedRepo] = useState<string>();
  const checkoutRepos = repos.filter((candidate) => Schema.is(GithubRepoSlug)(candidate));
  const referenceRepo = pickedRepo ?? repo ?? (checkoutRepos.length === 1 ? checkoutRepos[0] : undefined);
  useEffect(() => setPickedRepo(undefined), [repo]);
  // A thread keeps its unsent picks to itself; the unsuffixed keys belong to the new-thread composer.
  const pickSuffix = taskId === undefined ? "" : `.${taskId}`;
  const [pickedModel, setPickedModel, clearPickedModel] = useStoredChoice(`kestrel.model${pickSuffix}`, AgentModel);
  const [pickedEffort, setPickedEffort, clearPickedEffort] = useStoredChoice(`kestrel.effort${pickSuffix}`, EffortPick);
  const [defaultModel] = useStoredChoice("kestrel.model", AgentModel);
  const [defaultEffort] = useStoredChoice("kestrel.effort", EffortPick);
  const [choice, setChoice] = useState<{ askId: string; index: number } | undefined>();
  // Every catalogued action runs in the app; the exhaustive map makes a new app command fail here until both hosts
  // say what it does.
  const appCommandHandlers: AppCommandHandlers = {
    usage: () => navigation.push({ name: "usage" }),
  };
  // The screen unmounts as an app action opens; a bridge change still in flight must not restore the consumed text.
  const handledAppCommand = useRef(false);
  const [appCommandPending, setAppCommandPending] = useState(false);
  const [appCommandError, setAppCommandError] = useState<unknown>();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const askOptions = ask?.options ?? [];
  const chosenIndex = choice !== undefined && choice.askId === ask?.id ? choice.index : undefined;
  const chosenOption = chosenIndex === undefined ? undefined : askOptions[chosenIndex];

  const connected = connections.data ? connectedModelProviders(connections.data) : [];
  const sections: readonly ModelSection[] | null = connections.data
    ? connected
        .map((provider) => ({ provider, models: shown[provider.id] }))
        .filter((section) => section.models.length > 0)
    : null;
  const offered = sections?.flatMap((section) => section.models) ?? [];
  const { model, effort } = resolveAgentChoice({ offered, connected, pickedModel, pickedEffort, lastRun, defaultModel, defaultEffort });
  const effortOptions = (model?.efforts ?? []).map((e) => ({
    value: e,
    label: e === "none" ? "Off" : EFFORT_LABELS[e],
  }));

  // Slash commands
  const visible = view.plain;
  const firstSpace = visible.search(/\s/);
  const commandTokenEnd = firstSpace === -1 ? visible.length : firstSpace;
  const trigger: "/" | "$" | undefined = visible.startsWith("/") ? "/" : visible.startsWith("$") ? "$" : undefined;
  const expectedProvider = activeRunProvider ?? model?.provider;
  const triggerAllowed =
    trigger === "/" ||
    (trigger === "$" &&
      (expectedProvider === "openai" || (activeRunId !== undefined && activeRunProvider === undefined)));
  const slashQuery =
    (taskId !== undefined || trigger === "/") &&
    trigger !== undefined &&
    triggerAllowed &&
    view.caret > 0 &&
    view.caret <= commandTokenEnd
      ? visible.slice(1, commandTokenEnd)
      : undefined;

  const commandQuery = useQuery({
    ...queries.commands(taskId, model?.id, activeRunId, activeRunProvider),
    enabled: slashQuery !== undefined && taskId !== undefined && model !== undefined,
  });

  const commandProvider = commandQuery.data?.provider ?? expectedProvider;
  // Codex lists its commands and skills on `/`, and only its skills on their native `$`. App actions are always
  // listed and shadow same-named harness commands, but never a `$skill`.
  const commandMatches =
    slashQuery === undefined
      ? []
      : withAppCommands(commandQuery.data?.commands ?? [], commandProvider).filter(
          (c) =>
            (trigger !== "$" || harnessCommandPrefix(c, commandProvider) === "$") &&
            c.name.toLowerCase().startsWith(slashQuery.toLowerCase())
        );

  // Touching the native/web menu blurs the DOM editor before a Pressable's onPress can select a command.
  // Like references, keep the active token available across that focus change.
  // A new thread has no harness to ask, so nothing beyond the app's own commands can match there.
  const slashMenuOpen =
    slashQuery !== undefined &&
    (trigger !== "$" || commandProvider === "openai") &&
    (taskId !== undefined || commandMatches.length > 0) &&
    !dismissed;
  const selectedCommand = commandMatches[activeCommandIndex % commandMatches.length];
  const referenceTrigger = findGithubReferenceTrigger(view.referenceText, view.caret);
  // A repository sheet or a touch choice takes focus from the editor; keep the active token available until chosen.
  const referenceMenuOpen = referenceTrigger !== undefined && !dismissed;
  const menuOpen = referenceMenuOpen || slashMenuOpen;

  useEffect(() => setActiveReferenceIndex(0), [referenceTrigger?.start, referenceTrigger?.number]);
  useEffect(() => setActiveCommandIndex(0), [slashQuery, taskId, model?.id, activeRunId]);

  function edit(next: ComposerEditorView) {
    // An app action has already persisted the remainder and is opening its screen; ignore echoes of the old draft.
    if (handledAppCommand.current) return;
    if (next.markdown !== text) setText(next.markdown);
    if (next.markdown !== view.markdown || next.caret !== view.caret) setDismissed(false);
    setView(next);
  }

  /** Keep the live remainder durable before opening a screen that unmounts this editor. */
  async function runAppCommand(command: AppCommand, markdown: string, consumed: number): Promise<boolean> {
    if (handledAppCommand.current) return true;
    handledAppCommand.current = true;
    setAppCommandPending(true);
    setAppCommandError(undefined);
    try {
      await setText(markdown.slice(consumed));
      if (mounted.current) appCommandHandlers[command.name]();
      return true;
    } catch (error) {
      if (!mounted.current) return true;
      handledAppCommand.current = false;
      setAppCommandPending(false);
      setAppCommandError(error);
      return false;
    }
  }

  async function selectAppCommand(name: AppCommand["name"], next: ComposerEditorView) {
    const match = matchAppCommand(next.markdown, name);
    return match === undefined ? false : runAppCommand(match.command, next.markdown, match.consumed);
  }

  function chooseCommand(command: HarnessCommand) {
    // App actions run on selection instead of completing the draft; they win over a same-named harness command.
    const appCommand = appCommandOf(command, commandProvider);
    if (appCommand !== undefined) {
      editor.current?.requestAppCommand(appCommand.name);
      return;
    }
    const prefix = harnessCommandPrefix(command, commandQuery.data?.provider);
    const gap = /^\s*/.exec(visible.slice(commandTokenEnd))?.[0].length ?? 0;
    editor.current?.replaceRange(0, commandTokenEnd + gap, `${prefix}${command.name} `);
    setDismissed(true);
  }

  function chooseReference(kind: GithubReferenceKind) {
    if (referenceTrigger === undefined || referenceRepo === undefined) return;
    editor.current?.insertReference(
      { repo: referenceRepo, kind, number: referenceTrigger.number },
      referenceTrigger.start,
      referenceTrigger.end
    );
    setDismissed(true);
  }

  function chooseRepo(next: string) {
    setPickedRepo(next);
    onRepoChange?.(next);
    editor.current?.focusAt(referenceTrigger?.end ?? view.caret);
  }

  async function menuKey(key: string) {
    if (key === "Escape") {
      setDismissed(true);
    } else if (referenceMenuOpen) {
      if (key === "ArrowDown" || key === "ArrowUp") {
        setActiveReferenceIndex((index) => (index + (key === "ArrowDown" ? 1 : -1) + 2) % 2);
      } else if (key === "Enter" || key === "Tab") {
        chooseReference(activeReferenceIndex === 0 ? "pr" : "issue");
      }
    } else if (slashMenuOpen && commandMatches.length > 0) {
      if (key === "ArrowDown" || key === "ArrowUp") {
        setActiveCommandIndex((index) => (index + (key === "ArrowDown" ? 1 : -1) + commandMatches.length) % commandMatches.length);
      } else if (key === "Enter" || key === "Tab") {
        if (selectedCommand !== undefined) chooseCommand(selectedCommand);
      }
    }
  }

  const empty = text.trim() === "" && chosenOption === undefined;

  async function submit(next: ComposerEditorView) {
    // A typed app command runs in the app even with the menu closed or a turn active; it never reaches the agent.
    // With a picked answer the message answers the question, exactly as before.
    if (chosenOption === undefined) {
      const appCommand = matchAppCommand(next.markdown);
      if (appCommand !== undefined) {
        // Re-enter the DOM to lock and capture again; ordinary Send must not blur or disable the editor.
        editor.current?.requestAppCommand(appCommand.command.name);
        return;
      }
    }
    // Capture the DOM's current Markdown at the button press, not an earlier native bridge acknowledgement.
    const body = [chosenOption ?? "", next.markdown.trim()].filter(Boolean).join("\n\n");
    if (body === "" || pending) return;
    void onSend({ text: body, model: model?.id, effort }).then(
      (sent) => {
        editor.current?.clear();
        setText("");
        setChoice(undefined);
        // The new run now records these picks. A message joining a running turn keeps them for the next turn.
        if (taskId !== undefined && sent !== undefined && sent.message.afterItems === undefined) {
          void clearPickedModel(pickedModel);
          void clearPickedEffort(pickedEffort);
        }
      },
      () => undefined
    );
  }

  const computedPlaceholder =
    placeholder ??
    (ask
      ? askOptions.length > 0
        ? "Pick an answer, or type your own"
        : "Type your answer"
      : "Message the agent");

  return (
    <View style={styles.wrap}>
      {error ? <Alert>{errorText(error)}</Alert> : null}
      {appCommandError ? <Alert>{errorText(appCommandError)}</Alert> : null}
      {referenceMenuOpen && referenceTrigger !== undefined ? (
        <GithubReferenceMenu
          number={referenceTrigger.number}
          repo={referenceRepo}
          onRepoChange={chooseRepo}
          onSelect={chooseReference}
          activeIndex={activeReferenceIndex}
          onActiveIndexChange={setActiveReferenceIndex}
        />
      ) : slashMenuOpen ? (
        <SlashCommands
          matches={commandMatches}
          provider={commandProvider}
          pending={commandQuery.isPending}
          onSelect={chooseCommand}
          activeIndex={activeCommandIndex}
        />
      ) : null}
      <View style={[styles.box, focused && styles.boxFocused]}>
        {context ? <ContextBar context={context} /> : null}
        {ask ? (
          <AskPanel
            ask={ask}
            chosen={chosenIndex}
            onChoose={(index) => setChoice({ askId: ask.id, index })}
          />
        ) : null}
        {draftReady ? (
          <ComposerEditor
            ref={editor}
            value={initialDraft.current ?? ""}
            placeholder={computedPlaceholder}
            ariaExpanded={menuOpen}
            menuOpen={menuOpen}
            onChange={async (next) => edit(next)}
            onFocus={async () => setFocused(true)}
            onBlur={async () => setFocused(false)}
            onMenuKey={menuKey}
            onSubmit={submit}
            onAppCommand={selectAppCommand}
            // The DOM WebView defaults its container to flex: 1, which collapses inside this auto-height box.
            // Let matchContents supply the outer height, with the WebView filling that measured container.
            dom={{ matchContents: true, scrollEnabled: false, containerStyle: { flex: 0 }, style: { flex: 1 } }}
          />
        ) : <View style={{ minHeight: 48 }} />}
        <View style={styles.row}>
          <ModelPicker
            sections={sections}
            value={model}
            onChange={setPickedModel}
            onManage={() => navigation.push({ name: "connections" })}
          />
          {model !== undefined && model.efforts.length > 0 ? (
            <ThinkingPicker value={effort} options={effortOptions} onChange={setPickedEffort} />
          ) : null}
          <View style={styles.flex} />
          {onStop && empty && !appCommandPending ? (
            <Button size="icon" accessibilityLabel="Stop" disabled={stopping} onPress={onStop}>
              <Square size={14} color={colors.primaryForeground} fill={colors.primaryForeground} />
            </Button>
          ) : (
            <Button size="icon" accessibilityLabel="Send" disabled={pending || appCommandPending || empty || !draftReady} onPress={() => editor.current?.requestSubmit()}>
              {pending || appCommandPending ? (
                <ActivityIndicator size="small" color={colors.primaryForeground} />
              ) : (
                <ArrowUp size={16} color={colors.primaryForeground} />
              )}
            </Button>
          )}
        </View>
      </View>
      {below !== undefined ? <View style={styles.below}>{below}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  // Cancels the wrap's gap, so what hangs under the box touches it.
  below: { marginTop: -spacing.sm },
  wrap: { gap: spacing.sm, paddingHorizontal: spacing.md, paddingTop: spacing.sm, paddingBottom: spacing.md },
  box: {
    gap: spacing.xs,
    borderRadius: radius.xxl,
    backgroundColor: colors.secondary,
    padding: spacing.sm,
    borderWidth: 1,
    borderColor: "transparent",
    ...shadows.soft,
  },
  boxFocused: { borderColor: "rgba(255,255,255,0.14)" },
  askPanel: {
    paddingHorizontal: 6,
    paddingTop: 6,
    paddingBottom: spacing.sm,
    gap: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    marginBottom: spacing.xs,
  },
  askImage: {
    width: "100%",
    height: 160,
    borderRadius: radius.lg,
  },
  askOptions: {
    gap: 6,
    marginTop: spacing.xs,
  },
  askOption: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    borderRadius: radius.lg,
    backgroundColor: colors.white03,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderWidth: 1,
    borderColor: "transparent",
  },
  askOptionSelected: {
    backgroundColor: colors.white12,
    borderColor: "rgba(255,255,255,0.25)",
  },
  askOptionPressed: {
    backgroundColor: colors.white06,
  },
  askBadge: {
    width: 20,
    height: 20,
    borderRadius: radius.sm,
    backgroundColor: colors.white08,
    alignItems: "center",
    justifyContent: "center",
  },
  askBadgeSelected: {
    backgroundColor: colors.foreground,
  },
  askBadgeText: {
    fontSize: 11,
    fontFamily: fonts.mono,
    color: colors.mutedForeground,
  },
  askBadgeTextSelected: {
    color: colors.primaryForeground,
  },
  askOptionText: {
    flex: 1,
    fontSize: 14,
    color: colors.foreground,
  },
  row: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
  modelPill: { flexShrink: 1, minWidth: 0 },
  pillText: { color: colors.mutedForeground, fontSize: 12, fontWeight: "500", flexShrink: 1 },
  sheet: {
    backgroundColor: colors.secondary,
    borderTopLeftRadius: radius.xxl,
    borderTopRightRadius: radius.xxl,
    paddingHorizontal: spacing.sm,
    paddingTop: spacing.md,
    paddingBottom: spacing.xxl,
  },
  sheetTall: { maxHeight: "75%" },
  sheetScroll: { flexGrow: 0, flexShrink: 1 },
  modalRoot: { flex: 1, justifyContent: "flex-end" },
  backdropFill: { position: "absolute", top: 0, bottom: 0, left: 0, right: 0, backgroundColor: colors.scrim },
  sectionHeader: { color: colors.mutedForeground, fontSize: 12, fontWeight: "600", paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginVertical: spacing.xs },
  manageText: { color: colors.mutedForeground, fontSize: 14 },
  sheetLabel: { color: colors.mutedForeground, fontSize: 12, paddingHorizontal: spacing.md, paddingBottom: spacing.sm },
  thinkingSheet: { paddingHorizontal: spacing.xl },
  thinkingHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: spacing.sm },
  thinkingLabel: { color: colors.mutedForeground, fontSize: 12 },
  thinkingValue: { color: colors.foreground, fontSize: 14, fontWeight: "600" },
  sliderHitArea: { height: 44, justifyContent: "center" },
  sliderTrack: { height: 32, borderRadius: radius.full, backgroundColor: colors.input },
  sliderFill: { position: "absolute", left: 4, top: 4, height: 24, borderRadius: radius.full, backgroundColor: colors.primary + "33" },
  sliderStop: { position: "absolute", top: 14, width: 4, height: 4, borderRadius: radius.full },
  sliderThumb: { position: "absolute", top: 4, width: 24, height: 24, borderRadius: radius.full, backgroundColor: colors.primary, ...shadows.soft },
  thinkingEndpoints: { flexDirection: "row", justifyContent: "space-between" },
  option: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  optionPressed: { backgroundColor: colors.white06 },
  optionCheck: { width: 16 },
  optionText: { color: colors.foreground, fontSize: 16 },
});
