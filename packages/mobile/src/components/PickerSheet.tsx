import React, { type ReactNode, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import Check from "lucide-react-native/icons/check";
import { Input } from "@/components/ui/Input";
import { colors, radius, spacing } from "@/theme";

/** Most of the screen a picker sheet may cover; past that its list scrolls. */
const SHEET_MAX_SHARE = 0.75;

export interface PickerOption {
  readonly key: string;
  readonly label: string;
  /** A second, muted line under the label. */
  readonly detail?: string;
  /** Marks after the label, e.g. a lock for a private repository. */
  readonly trailing?: ReactNode;
}

/**
 * A bottom sheet to pick one option: the web new-thread bar's dropdown menus on a phone. With `filter`, a box on top
 * narrows the list by label (case-insensitive); `pinned` options stay above the list while the filter is empty.
 * `message` replaces the list for loading, error and empty states.
 */
export function PickerSheet({
  open,
  onClose,
  title,
  options,
  pinned = [],
  selected,
  onSelect,
  filter,
  message,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  options: readonly PickerOption[];
  pinned?: readonly PickerOption[];
  selected: string | undefined;
  onSelect: (key: string) => void;
  filter?: { placeholder: string; empty: (query: string) => string };
  message?: string | undefined;
  footer?: ReactNode;
}) {
  const { height } = useWindowDimensions();
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const matches = q === "" ? options : options.filter((option) => option.label.toLowerCase().includes(q));
  const shown = q === "" ? [...pinned, ...matches] : matches;
  const close = () => {
    setQuery("");
    onClose();
  };
  const note = message ?? (filter !== undefined && q !== "" && matches.length === 0 ? filter.empty(query.trim()) : undefined);

  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={close}>
      <View style={styles.container}>
        {/* A sibling under the sheet, not its parent, so a drag through the list scrolls instead of closing it. */}
        <Pressable style={styles.backdrop} accessibilityLabel="Close" onPress={close} />
        <View style={[styles.sheet, { maxHeight: height * SHEET_MAX_SHARE }]}>
          <Text style={styles.heading}>{title}</Text>
          {filter !== undefined && message === undefined ? (
            <Input
              value={query}
              onChangeText={setQuery}
              placeholder={filter.placeholder}
              accessibilityLabel={filter.placeholder}
              autoCapitalize="none"
              autoCorrect={false}
              style={styles.filter}
            />
          ) : null}
          <ScrollView contentContainerStyle={styles.list} keyboardShouldPersistTaps="handled" bounces={false}>
            {message === undefined
              ? shown.map((option) => (
                  <Pressable
                    key={option.key}
                    style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: option.key === selected }}
                    onPress={() => {
                      onSelect(option.key);
                      close();
                    }}
                  >
                    <View style={styles.text}>
                      <Text style={styles.label} numberOfLines={1}>
                        {option.label}
                      </Text>
                      {option.detail !== undefined ? <Text style={styles.detail}>{option.detail}</Text> : null}
                    </View>
                    {option.trailing}
                    <View style={styles.check}>
                      {option.key === selected ? <Check size={16} color={colors.foreground} /> : null}
                    </View>
                  </Pressable>
                ))
              : null}
            {note !== undefined ? <Text style={styles.note}>{note}</Text> : null}
            {footer}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: "flex-end" },
  backdrop: { ...StyleSheet.absoluteFill, backgroundColor: colors.scrim },
  sheet: {
    backgroundColor: colors.secondary,
    borderTopLeftRadius: radius.xxl,
    borderTopRightRadius: radius.xxl,
    padding: spacing.sm,
    paddingBottom: spacing.xxl,
  },
  heading: { color: colors.mutedForeground, fontSize: 12, fontWeight: "600", padding: spacing.md },
  filter: { marginHorizontal: spacing.xs, marginBottom: spacing.xs },
  list: { gap: 2 },
  row: { flexDirection: "row", alignItems: "center", gap: spacing.md, minHeight: 44, paddingHorizontal: spacing.md, borderRadius: radius.md },
  rowPressed: { backgroundColor: colors.accent },
  text: { flex: 1, minWidth: 0, paddingVertical: spacing.xs },
  label: { color: colors.foreground, fontSize: 15 },
  detail: { color: colors.mutedForeground, fontSize: 12 },
  check: { width: 16 },
  note: { color: colors.mutedForeground, fontSize: 14, padding: spacing.md },
});
