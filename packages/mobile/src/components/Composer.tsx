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
import { colors, radius, shadows, spacing } from "@/theme";

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
}

export function Composer({ onSend, pending, error, onStop, stopping, placeholder }: ComposerProps) {
  const { api } = useApiClient();
  const navigation = useNavigation();
  const queries = useMemo(() => createQueries(api), [api]);
  const connections = useQuery(queries.connections());
  const shown = useShownModels();
  const [text, setText] = useState("");
  const [focused, setFocused] = useState(false);
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

  function submit() {
    const body = text.trim();
    // Failures surface through `error`; the text stays so it can be resent.
    if (body === "" || pending) return;
    void onSend({ text: body, model: model?.id, effort }).then(
      () => setText(""),
      () => undefined
    );
  }

  return (
    <View style={styles.wrap}>
      {error ? <Alert>{errorText(error)}</Alert> : null}
      <View style={[styles.box, focused && styles.boxFocused]}>
        <TextInput
          style={styles.input}
          value={text}
          onChangeText={setText}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder={placeholder ?? "Message the agent"}
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
  pillText: { color: colors.mutedForeground, fontSize: 12, fontWeight: "500" },
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
