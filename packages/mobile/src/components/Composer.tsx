import React, { useMemo, useState } from "react";
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import {
  AgentEffort,
  AgentModel,
  EFFORT_LABELS,
  connectedModelProviders,
  type ModelInfo,
  type ModelProviderInfo,
  type SendMessageBody,
} from "@cloudagents/protocol";
import { createQueries } from "@/api/queries";
import { useApiClient } from "@/hooks/useApiClient";
import { useShownModels } from "@/hooks/useShownModels";
import { useStoredChoice } from "@/hooks/useStoredChoice";
import { useNavigation } from "@/nav/navigation";
import { errorText } from "@/lib/format";
import { colors, radius, spacing } from "@/theme";

interface PickerOption<T extends string> {
  readonly value: T | undefined;
  readonly label: string;
}

/** A connected provider and the models the user keeps in the picker for it. */
interface ModelSection {
  readonly provider: ModelProviderInfo;
  readonly models: readonly ModelInfo[];
}

interface PillPickerProps<T extends string> {
  readonly label: string;
  readonly value: T | undefined;
  readonly options: readonly PickerOption<T>[];
  readonly onChange: (value: T | undefined) => void;
}

function PillPicker<T extends string>({ label, value, options, onChange }: PillPickerProps<T>) {
  const [open, setOpen] = useState(false);
  const shown = value === undefined ? label : (options.find((o) => o.value === value)?.label ?? label);
  return (
    <>
      <Pressable style={styles.pill} onPress={() => setOpen(true)} accessibilityRole="button" accessibilityLabel={label}>
        <Text style={styles.pillText}>{shown} ▾</Text>
      </Pressable>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle}>{label}</Text>
            {options.map((o) => (
              <Pressable
                key={o.label}
                style={styles.option}
                onPress={() => {
                  onChange(o.value);
                  setOpen(false);
                }}
              >
                <Text style={[styles.optionText, o.value === value && styles.optionSelected]}>{o.label}</Text>
              </Pressable>
            ))}
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
      <Pressable
        style={styles.pill}
        onPress={() => (nothingOffered ? onManage() : setOpen(true))}
        accessibilityRole="button"
        accessibilityLabel="Model"
      >
        <Text style={styles.pillText}>{shown} ▾</Text>
      </Pressable>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <View style={styles.modalRoot}>
          <Pressable style={styles.backdropFill} onPress={() => setOpen(false)} />
          <View style={[styles.sheet, styles.sheetTall]}>
            <Text style={styles.sheetTitle}>Model</Text>
            <ScrollView style={styles.sheetScroll}>
              {sections?.map((section, i) => (
                <React.Fragment key={section.provider.id}>
                  {i > 0 ? <View style={styles.divider} /> : null}
                  <Text style={styles.sectionHeader}>{section.provider.name}</Text>
                  {section.models.map((m) => (
                    <Pressable
                      key={m.id}
                      style={styles.option}
                      onPress={() => {
                        onChange(m.id);
                        setOpen(false);
                      }}
                      accessibilityRole="button"
                      accessibilityState={{ selected: m.id === value?.id }}
                    >
                      <Text style={[styles.optionText, m.id === value?.id && styles.optionSelected]}>{m.name}</Text>
                      {m.id === value?.id ? <Text style={styles.optionCheck}>✓</Text> : null}
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
}

export function Composer({ onSend, pending, error, onStop, stopping, placeholder }: ComposerProps) {
  const { api } = useApiClient();
  const navigation = useNavigation();
  const queries = useMemo(() => createQueries(api), [api]);
  const connections = useQuery(queries.connections());
  const shown = useShownModels();
  const [text, setText] = useState("");
  const [storedModel, setModel] = useStoredChoice("kestrel.model", AgentModel);
  const [storedEffort, setEffort] = useStoredChoice("kestrel.effort", AgentEffort);

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
  const empty = text.trim() === "";
  const showStop = onStop !== undefined && empty;

  function submit() {
    const body = text.trim();
    if (body === "" || pending) return;
    // A failed send keeps the text so it can be resent; the error is shown through `error`.
    void onSend({ text: body, model: model?.id, effort }).then(
      () => setText(""),
      () => undefined
    );
  }

  return (
    <View style={styles.wrap}>
      {error ? <Text style={styles.error}>{errorText(error)}</Text> : null}
      <View style={styles.box}>
        <TextInput
          style={styles.input}
          value={text}
          onChangeText={setText}
          placeholder={placeholder ?? "Message the agent"}
          placeholderTextColor={colors.mutedForeground}
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
          {showStop ? (
            <Pressable
              style={[styles.roundBtn, stopping && styles.disabled]}
              disabled={stopping}
              onPress={onStop}
              accessibilityRole="button"
              accessibilityLabel="Stop"
            >
              <View style={styles.stopSquare} />
            </Pressable>
          ) : (
            <Pressable
              style={[styles.roundBtn, (pending || empty) && styles.disabled]}
              disabled={pending || empty}
              onPress={submit}
              accessibilityRole="button"
              accessibilityLabel="Send"
            >
              {pending ? (
                <ActivityIndicator size="small" color={colors.primaryForeground} />
              ) : (
                <Text style={styles.sendArrow}>↑</Text>
              )}
            </Pressable>
          )}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  wrap: { gap: spacing.sm, padding: spacing.md },
  error: { color: colors.destructive, fontSize: 13 },
  box: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.xl,
    backgroundColor: colors.card,
    padding: spacing.sm,
    gap: spacing.sm,
  },
  input: { color: colors.foreground, fontSize: 16, minHeight: 40, maxHeight: 160, paddingHorizontal: spacing.sm },
  row: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  pill: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  pillText: { color: colors.mutedForeground, fontSize: 13 },
  roundBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  disabled: { opacity: 0.4 },
  sendArrow: { color: colors.primaryForeground, fontSize: 18, fontWeight: "700" },
  stopSquare: { width: 12, height: 12, borderRadius: 2, backgroundColor: colors.primaryForeground },
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-end" },
  modalRoot: { flex: 1, justifyContent: "flex-end" },
  backdropFill: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: "rgba(0,0,0,0.4)",
  },
  sheet: {
    backgroundColor: colors.card,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    padding: spacing.lg,
    gap: spacing.xs,
  },
  sheetTall: { maxHeight: "75%" },
  sheetScroll: { flexGrow: 0, flexShrink: 1 },
  sheetTitle: { color: colors.mutedForeground, fontSize: 13, marginBottom: spacing.sm },
  sectionHeader: {
    color: colors.mutedForeground,
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.6,
    textTransform: "uppercase",
    paddingVertical: spacing.xs,
  },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginVertical: spacing.xs },
  option: { paddingVertical: spacing.md, flexDirection: "row", alignItems: "center", gap: spacing.sm },
  optionText: { color: colors.foreground, fontSize: 16 },
  optionSelected: { fontWeight: "700" },
  optionCheck: { color: colors.primary, fontSize: 16, fontWeight: "700" },
  manageText: { color: colors.mutedForeground, fontSize: 16 },
});
