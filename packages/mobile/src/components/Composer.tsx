import React, { useState } from "react";
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { AgentEffort, AgentModel, type SendMessageBody } from "@cloudagents/protocol";
import { useStoredChoice } from "@/hooks/useStoredChoice";
import { errorText } from "@/lib/format";
import { colors, radius, spacing } from "@/theme";

interface PickerOption<T extends string> {
  readonly value: T | undefined;
  readonly label: string;
}

const MODEL_OPTIONS: readonly PickerOption<AgentModel>[] = [
  { value: undefined, label: "Default" },
  { value: "opus", label: "Opus" },
  { value: "sonnet", label: "Sonnet" },
  { value: "haiku", label: "Haiku" },
];

const EFFORT_OPTIONS: readonly PickerOption<AgentEffort>[] = [
  { value: undefined, label: "Default" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra high" },
  { value: "max", label: "Max" },
];

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
  const [text, setText] = useState("");
  const [model, setModel] = useStoredChoice("kestrel.model", AgentModel);
  const [effort, setEffort] = useStoredChoice("kestrel.effort", AgentEffort);
  const empty = text.trim() === "";
  const showStop = onStop !== undefined && empty;

  function submit() {
    const body = text.trim();
    if (body === "" || pending) return;
    // A failed send keeps the text so it can be resent; the error is shown through `error`.
    void onSend({ text: body, model, effort }).then(
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
          <PillPicker label="Model" value={model} options={MODEL_OPTIONS} onChange={setModel} />
          <PillPicker label="Thinking" value={effort} options={EFFORT_OPTIONS} onChange={setEffort} />
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
  sheet: {
    backgroundColor: colors.card,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    padding: spacing.lg,
    gap: spacing.xs,
  },
  sheetTitle: { color: colors.mutedForeground, fontSize: 13, marginBottom: spacing.sm },
  option: { paddingVertical: spacing.md },
  optionText: { color: colors.foreground, fontSize: 16 },
  optionSelected: { fontWeight: "700" },
});
