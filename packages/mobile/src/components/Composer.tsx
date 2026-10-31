import React, { useMemo, useState } from "react";
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { ArrowUp, Check, ChevronDown, Settings2, Square } from "lucide-react-native";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import {
  AgentEffort,
  AgentModel,
  EFFORT_LABELS,
  connectedModelProviders,
  type ContextUsage,
  type HarnessCommand,
  type Message,
  type ModelInfo,
  type ModelProvider,
  type ModelProviderInfo,
  type SendMessageBody,
} from "@cloudagents/protocol";
import { AttachmentImage } from "@/components/AttachmentImage";
import { createQueries } from "@/api/queries";
import { useApiClient } from "@/hooks/useApiClient";
import { useShownModels } from "@/hooks/useShownModels";
import { useStoredChoice } from "@/hooks/useStoredChoice";
import { useNavigation } from "@/nav/navigation";
import { errorText } from "@/lib/format";
import { colors, fonts, radius, shadows, spacing } from "@/theme";
import { ContextBar } from "./ContextBar";
import { Markdown } from "./Markdown";
import { SlashCommands } from "./SlashCommands";

interface PickerOption<T extends string> {
  readonly value: T | undefined;
  readonly label: string;
}

/** A connected provider and the models the user keeps in the picker for it. */
interface ModelSection {
  readonly provider: ModelProviderInfo;
  readonly models: readonly ModelInfo[];
}

/**
 * A pill that opens a single-choice menu; shows its label until something other than Default is picked.
 * The web dropdown becomes a bottom sheet.
 */
function PillPicker<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T | undefined;
  options: readonly PickerOption<T>[];
  onChange: (value: T | undefined) => void;
}) {
  const [open, setOpen] = useState(false);
  const shown = value === undefined ? label : (options.find((o) => o.value === value)?.label ?? label);
  return (
    <>
      <Button variant="ghost" size="sm" active={open} onPress={() => setOpen(true)} accessibilityLabel={label}>
        <Text style={styles.pillText}>{shown}</Text>
        <ChevronDown size={16} color={colors.mutedForeground + "99"} />
      </Button>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
          <View style={styles.sheet}>
            <Text style={styles.sheetLabel}>{label}</Text>
            {options.map((o) => {
              const selected = o.value === value;
              return (
                <Pressable
                  key={o.label}
                  style={({ pressed }) => [styles.option, pressed && styles.optionPressed]}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: selected }}
                  onPress={() => {
                    onChange(o.value);
                    setOpen(false);
                  }}
                >
                  <View style={styles.optionCheck}>
                    {selected ? <Check size={16} color={colors.foreground} /> : null}
                  </View>
                  <Text style={styles.optionText}>{o.label}</Text>
                </Pressable>
              );
            })}
          </View>
        </Pressable>
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
  readonly onSend: (body: SendMessageBody) => Promise<unknown>;
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
  readonly activeRunProvider?: ModelProvider;
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
          taskId={ask.taskId}
          attachmentId={a.id}
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
}: ComposerProps) {
  const { api } = useApiClient();
  const navigation = useNavigation();
  const queries = useMemo(() => createQueries(api), [api]);
  const connections = useQuery(queries.connections());
  const shown = useShownModels();
  const [text, setText] = useState("");
  const [focused, setFocused] = useState(false);
  const [storedModel, setModel] = useStoredChoice("kestrel.model", AgentModel);
  const [storedEffort, setEffort] = useStoredChoice("kestrel.effort", AgentEffort);
  const [choice, setChoice] = useState<{ askId: string; index: number } | undefined>();

  const askOptions = ask?.options ?? [];
  const chosenIndex = choice !== undefined && choice.askId === ask?.id ? choice.index : undefined;
  const chosenOption = chosenIndex === undefined ? undefined : askOptions[chosenIndex];

  const sections: readonly ModelSection[] | null = connections.data
    ? connectedModelProviders(connections.data)
        .map((provider) => ({ provider, models: shown[provider.id] }))
        .filter((section) => section.models.length > 0)
    : null;
  // The stored pick counts only while it is on offer; otherwise the first model on offer stands in, unsaved.
  const offered = sections?.flatMap((section) => section.models) ?? [];
  const model = offered.find((m) => m.id === storedModel) ?? offered[0];
  const effort = storedEffort !== undefined && model?.efforts.includes(storedEffort) ? storedEffort : undefined;
  const effortOptions: readonly PickerOption<AgentEffort>[] = [
    { value: undefined, label: "Default" },
    ...(model?.efforts ?? []).map((e) => ({ value: e, label: EFFORT_LABELS[e] })),
  ];

  // Slash commands
  const firstSpace = text.search(/\s/);
  const commandTokenEnd = firstSpace === -1 ? text.length : firstSpace;
  const trigger: "/" | "$" | undefined = text.startsWith("/") ? "/" : text.startsWith("$") ? "$" : undefined;
  const expectedProvider = activeRunProvider ?? model?.provider;
  const triggerAllowed =
    trigger === "/" ||
    (trigger === "$" &&
      (expectedProvider === "openai" || (activeRunId !== undefined && activeRunProvider === undefined)));
  const slashQuery =
    taskId !== undefined && trigger !== undefined && triggerAllowed && (firstSpace === -1 || text.length <= firstSpace)
      ? text.slice(1)
      : undefined;

  const commandQuery = useQuery({
    ...queries.commands(taskId, model?.id, activeRunId, activeRunProvider),
    enabled: slashQuery !== undefined && taskId !== undefined && model !== undefined,
  });

  const commandProvider = commandQuery.data?.provider ?? expectedProvider;
  const slashMenuOpen =
    slashQuery !== undefined &&
    (trigger !== "$" || commandProvider === "openai") &&
    focused;

  const commandMatches =
    slashQuery === undefined
      ? []
      : (commandQuery.data?.commands ?? []).filter((c) =>
          c.name.toLowerCase().startsWith(slashQuery.toLowerCase())
        );

  function chooseCommand(command: HarnessCommand) {
    const prefix = commandQuery.data?.provider === "openai" ? "$" : "/";
    const rest = text.slice(commandTokenEnd).replace(/^\s+/, "");
    setText(`${prefix}${command.name} ${rest}`);
  }

  const empty = text.trim() === "" && chosenOption === undefined;

  function submit() {
    // Failures surface through `error`; the text stays so it can be resent.
    if (empty || pending) return;
    const body = [chosenOption ?? "", text.trim()].filter(Boolean).join("\n\n");
    void onSend({ text: body, model: model?.id, effort }).then(
      () => {
        setText("");
        setChoice(undefined);
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
      {slashMenuOpen ? (
        <SlashCommands
          matches={commandMatches}
          provider={commandProvider}
          pending={commandQuery.isPending}
          onSelect={chooseCommand}
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
        <TextInput
          style={styles.input}
          value={text}
          onChangeText={setText}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder={computedPlaceholder}
          placeholderTextColor={colors.mutedForeground + "b3"}
          multiline
        />
        <View style={styles.row}>
          <ModelPicker
            sections={sections}
            value={model}
            onChange={setModel}
            onManage={() => navigation.push({ name: "connections" })}
          />
          {model !== undefined && model.efforts.length > 0 ? (
            <PillPicker label="Thinking" value={effort} options={effortOptions} onChange={setEffort} />
          ) : null}
          <View style={styles.flex} />
          {onStop && empty ? (
            <Button size="icon" accessibilityLabel="Stop" disabled={stopping} onPress={onStop}>
              <Square size={14} color={colors.primaryForeground} fill={colors.primaryForeground} />
            </Button>
          ) : (
            <Button size="icon" accessibilityLabel="Send" disabled={pending || empty} onPress={submit}>
              {pending ? (
                <ActivityIndicator size="small" color={colors.primaryForeground} />
              ) : (
                <ArrowUp size={16} color={colors.primaryForeground} />
              )}
            </Button>
          )}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
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
  input: {
    color: colors.foreground,
    fontSize: 16,
    minHeight: 48,
    maxHeight: 160,
    paddingHorizontal: 6,
    paddingTop: 6,
    textAlignVertical: "top",
  },
  row: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
  modelPill: { flexShrink: 1, minWidth: 0 },
  pillText: { color: colors.mutedForeground, fontSize: 12, fontWeight: "500", flexShrink: 1 },
  backdrop: { flex: 1, backgroundColor: colors.scrim, justifyContent: "flex-end" },
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
