import React, { useEffect, useMemo, useState } from "react";
import {
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type TextInputKeyPressEvent,
} from "react-native";
import Check from "lucide-react-native/icons/check";
import ChevronDown from "lucide-react-native/icons/chevron-down";
import Settings2 from "lucide-react-native/icons/settings-2";
import X from "lucide-react-native/icons/x";
import Svg, { Circle } from "react-native-svg";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  EFFORT_LABELS,
  type AgentEffort,
  type AgentModel,
  type ModelInfo,
} from "@cloudagents/protocol";
import { modelDisplayName, type ModelSection } from "@cloudagents/composer/models";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { HarnessLogo } from "@/components/HarnessLogo";
import { HARNESSES, harnessForModel, type Harness } from "@/lib/harnesses";
import { thinkingFillWidth, thinkingStopOffsets } from "@/lib/thinking";
import { colors, radius, shadows, spacing } from "@/theme";
import { ThinkingSlider } from "@/components/ThinkingSlider";

export type { ModelSection } from "@cloudagents/composer/models";

// Match the desktop ring regardless of the model's number of supported levels.
const EFFORT_RING_FILL: Record<AgentEffort, number> = {
  none: 0,
  low: 25,
  medium: 50,
  high: 75,
  xhigh: 87.5,
  max: 100,
};

/** The thinking levels a model supports, labelled the way the composer labels them. */
export const effortOptions = (
  model: ModelInfo | undefined
): readonly { value: AgentEffort; label: string }[] =>
  (model?.efforts ?? []).map((effort) => ({
    value: effort,
    label: effort === "none" ? "Off" : EFFORT_LABELS[effort],
  }));

/**
 * The desktop thinking slider in a touch-sized sheet, shared by Expo and mobile web. `options` are the selected
 * model's supported levels, lowest first; render it only when the model supports at least one.
 */
export function ThinkingPicker({
  value,
  options,
  onChange,
  disabled = false,
}: {
  value: AgentEffort | undefined;
  options: readonly { value: AgentEffort; label: string }[];
  onChange: (value: AgentEffort) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [width, setWidth] = useState(0);
  const index = Math.max(0, options.findIndex((option) => option.value === value));
  const selected = options[index]!;
  const ringFill = EFFORT_RING_FILL[selected.value];
  // Both input implementations reserve 16px at each end for the thumb.
  const offsets = thinkingStopOffsets(options.length, width);
  const offset = (stop: number) => offsets[stop]!;
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        active={open}
        disabled={disabled}
        onPress={() => {
          if (!disabled) setOpen(true);
        }}
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
          <Pressable
            style={styles.backdrop}
            onPress={() => setOpen(false)}
            accessibilityLabel="Close thinking"
            accessibilityRole="button"
          />
          <View style={[styles.sheet, styles.thinkingSheet]}>
            <View style={styles.thinkingHeader}>
              <Text style={styles.thinkingLabel}>Thinking</Text>
              <Text style={styles.thinkingValue}>{selected.label}</Text>
            </View>
            <View style={styles.sliderHitArea} onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
              <View pointerEvents="none" style={styles.sliderTrack}>
                <View style={[styles.sliderFill, { width: thinkingFillWidth(options.length, width, index) }]} />
                {options.map((option, stop) => (
                  <View
                    key={option.label}
                    style={[
                      styles.sliderStop,
                      { left: offset(stop) - 2, backgroundColor: stop <= index ? colors.primary + "99" : colors.mutedForeground + "66" },
                    ]}
                  />
                ))}
                <View style={[styles.sliderThumb, { left: offset(index) - 12 }]} />
              </View>
              {options.length > 1 ? (
                <ThinkingSlider
                  value={index}
                  max={options.length - 1}
                  label={selected.label}
                  onChange={(stop) => onChange(options[stop]!.value)}
                />
              ) : null}
            </View>
            <View
              style={[styles.thinkingEndpoints, options.length === 1 && styles.thinkingEndpointsSingle]}
              aria-hidden
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
            >
              <Text style={styles.thinkingLabel}>{options[0]!.label}</Text>
              {options.length > 1 ? (
                <Text style={styles.thinkingLabel}>{options[options.length - 1]!.label}</Text>
              ) : null}
            </View>
          </View>
        </View>
      </Modal>
    </>
  );
}

/** A connected harness with the providers it runs that have models in the picker. */
interface HarnessTab {
  readonly harness: Harness;
  readonly sections: readonly ModelSection[];
}

/** One model in the searchable list, with the harness and provider that qualify it. */
interface MenuRow {
  readonly harness: Harness;
  readonly section: ModelSection;
  readonly model: ModelInfo;
}

/** A provider's matching models under its label in the menu. */
interface ModelGroup {
  readonly harness: Harness;
  readonly section: ModelSection;
  readonly models: readonly ModelInfo[];
}

// Sizes in dp: a provider label, a model row, and the sheet's fixed parts (header, search, Manage models, padding).
const LABEL_HEIGHT = 30;
const ROW_MIN_HEIGHT = 44;
const SHEET_HEADER = 48;
const SHEET_SEARCH = 48;
const SHEET_FOOTER = 48;
const SHEET_PADDING = spacing.sm * 2;
/** Shortest list box, so a single-model harness still fills the sheet sensibly. */
const LIST_MIN_HEIGHT = 132;
/** Tallest list box; the window caps it further. */
const LIST_MAX_HEIGHT = 380;

/** Every row the sheet can offer, in the desktop picker's order. */
function offeredRows(tabs: readonly HarnessTab[]): readonly MenuRow[] {
  return tabs.flatMap((tab) =>
    tab.sections.flatMap((section) => section.models.map((model) => ({ harness: tab.harness, section, model })))
  );
}

/** Whether a row matches every whitespace-separated term of the search across its identity. */
function matchesSearch(row: MenuRow, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter((term) => term !== "");
  const haystack =
    `${modelDisplayName(row.model)} ${row.model.name} ${row.model.id} ${row.section.provider.name} ${row.harness.name}`.toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

/**
 * Model sheet: a rail of the connected harnesses, the picked harness's models grouped by the provider behind them
 * (its subscription or an API key the user added), and a search box over every harness. Opening always starts on
 * the selected model's harness; a filter looks across all of them and labels each group with its harness and provider.
 * The sheet keeps the height its tallest harness needs before its list scrolls, so switching harnesses or searching
 * does not resize it. `sections` is null while connections load.
 *
 * `defaultLabel` names an unset choice. `onManage` adds the Manage models footer that opens Connections.
 */
export function ModelPicker({
  sections,
  value,
  onChange,
  defaultLabel,
  disabled = false,
  onManage,
}: {
  sections: readonly ModelSection[] | null;
  value: ModelInfo | undefined;
  onChange: (value: AgentModel) => void;
  defaultLabel?: string;
  disabled?: boolean;
  onManage?: () => void;
}) {
  const { height: windowHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [pickedHarness, setPickedHarness] = useState<string>();
  // iOS keyboard overlays the modal instead of resizing the window; keep the sheet above it (Android adjustResize and
  // phone web already shrink or omit the keyboard, and this listener is a no-op there).
  const [keyboardInset, setKeyboardInset] = useState(0);
  useEffect(() => {
    if (Platform.OS !== "ios") return;
    const show = Keyboard.addListener("keyboardWillShow", (event) => setKeyboardInset(event.endCoordinates.height));
    const hide = Keyboard.addListener("keyboardWillHide", () => setKeyboardInset(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  const tabs: readonly HarnessTab[] = useMemo(
    () =>
      HARNESSES.map((harness) => ({
        harness,
        sections: (sections ?? []).filter((section) => section.harness === harness.id),
      })).filter((tab) => tab.sections.length > 0),
    [sections]
  );
  const offered = useMemo(() => offeredRows(tabs), [tabs]);
  const needle = query.trim();
  const matched = useMemo(
    () => offered.filter((row) => matchesSearch(row, needle)),
    [offered, needle]
  );
  // Filter each group by the row objects that matched, not by model id: two providers may offer the same id.
  const matchedModels = useMemo(() => new Set(matched.map((row) => row.model)), [matched]);
  const valueHarness = value === undefined ? undefined : harnessForModel(value);
  // Opening clears the pick so the selected model's harness is restored every time.
  const tab =
    tabs.find((candidate) => candidate.harness.id === pickedHarness) ??
    tabs.find((candidate) => candidate.harness.id === valueHarness?.id) ??
    tabs[0];
  const searching = needle !== "";
  const groups: readonly ModelGroup[] = searching
    ? tabs.flatMap((candidate) =>
        candidate.sections
          .map((section) => ({
            harness: candidate.harness,
            section,
            models: section.models.filter((model) => matchedModels.has(model)),
          }))
          .filter((group) => group.models.length > 0)
      )
    : (tab?.sections.map((section) => ({ harness: tab.harness, section, models: section.models })) ?? []);

  const tallestTab = Math.max(
    2 * ROW_MIN_HEIGHT,
    ...tabs.map((candidate) =>
      candidate.sections.reduce((sum, section) => sum + LABEL_HEIGHT + section.models.length * ROW_MIN_HEIGHT, 0)
    )
  );
  const listHeight = Math.max(LIST_MIN_HEIGHT, Math.min(LIST_MAX_HEIGHT, tallestTab));
  // With the keyboard up, keep the sheet's top edge below the status bar/Dynamic Island and its bottom above the
  // keyboard, so the header and search stay on screen. Hidden keyboard keeps the normal content-bounded height.
  const keyboardTopGap = keyboardInset > 0 ? insets.top + spacing.sm : 0;
  const sheetHeight = Math.min(
    windowHeight * 0.8,
    windowHeight - keyboardInset - keyboardTopGap,
    SHEET_HEADER + SHEET_PADDING + listHeight + (tabs.length > 0 ? SHEET_SEARCH : 0) + (onManage ? SHEET_FOOTER : 0)
  );

  function close() {
    setOpen(false);
    setQuery("");
  }

  function openPicker() {
    setPickedHarness(undefined);
    setQuery("");
    setOpen(true);
  }

  function choose(model: ModelInfo) {
    onChange(model.id);
    close();
  }

  function stepHarness(delta: 1 | -1) {
    if (tab === undefined) return;
    const next = tabs[(tabs.indexOf(tab) + delta + tabs.length) % tabs.length]!;
    setPickedHarness(next.harness.id);
  }

  /** Phone-web keyboard shortcuts, matching desktop's: arrows step harnesses, Enter picks the first match, Esc closes. */
  function onSearchKeyPress(event: TextInputKeyPressEvent) {
    if (event.nativeEvent.key === "Escape") {
      close();
    } else if (!searching && tabs.length > 1) {
      if (event.nativeEvent.key === "ArrowRight") stepHarness(1);
      else if (event.nativeEvent.key === "ArrowLeft") stepHarness(-1);
    }
  }

  const label = value === undefined
    ? defaultLabel ?? (sections === null ? "Model" : "No models")
    : modelDisplayName(value);
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        active={open}
        disabled={disabled}
        style={styles.pill}
        onPress={openPicker}
        accessibilityLabel={`Model: ${label}`}
      >
        {valueHarness !== undefined ? <HarnessLogo harness={valueHarness.id} size={16} /> : null}
        <Text style={styles.pillText} numberOfLines={1}>{label}</Text>
        <ChevronDown size={16} color={colors.mutedForeground} />
      </Button>
      <Modal visible={open} transparent animationType="fade" onRequestClose={close}>
        <View style={styles.modalRoot}>
          {/* A sibling under the sheet, not its parent, so a drag through the list scrolls instead of closing it. */}
          <Pressable style={styles.backdrop} onPress={close} accessibilityLabel="Dismiss model picker" accessibilityRole="button" />
          <KeyboardAvoidingView
            behavior={Platform.OS === "ios" ? "padding" : undefined}
            pointerEvents="box-none"
          >
            <View
              style={[styles.sheet, { height: sheetHeight }]}
              accessibilityViewIsModal
              accessibilityLabel="Model picker"
            >
              <View style={styles.sheetHeader}>
                <Text style={styles.sheetTitle}>Model</Text>
                <Pressable
                  onPress={close}
                  hitSlop={spacing.sm}
                  accessibilityRole="button"
                  accessibilityLabel="Close model picker"
                  style={({ pressed }) => [styles.closeButton, pressed && styles.closeButtonPressed]}
                >
                  <X size={18} color={colors.mutedForeground} />
                </Pressable>
              </View>
              {tabs.length > 0 ? (
                <Input
                  value={query}
                  onChangeText={setQuery}
                  placeholder={tab !== undefined && !searching ? `Search models · ${tab.harness.name}` : "Search models"}
                  accessibilityLabel="Search models"
                  autoCapitalize="none"
                  autoCorrect={false}
                  returnKeyType="search"
                  onKeyPress={onSearchKeyPress}
                  onSubmitEditing={() => {
                    // Enter chooses the first row the user can see: search results, or the open tab's list.
                    const first = groups[0]?.models[0];
                    if (first !== undefined) choose(first);
                  }}
                  style={styles.search}
                />
              ) : null}
              <View style={styles.sheetBody}>
                {tabs.length > 0 && !searching ? (
                  // In the sheet's flow, never over the list: a scrollable strip of connected harnesses.
                  <ScrollView
                    style={styles.rail}
                    contentContainerStyle={styles.railContent}
                    showsVerticalScrollIndicator={false}
                    accessibilityRole="tablist"
                    accessibilityLabel="Harnesses"
                  >
                    {tabs.map((candidate) => {
                      const active = candidate === tab;
                      return (
                        <Pressable
                          key={candidate.harness.id}
                          onPress={() => setPickedHarness(candidate.harness.id)}
                          accessibilityRole="tab"
                          accessibilityLabel={candidate.harness.name}
                          accessibilityState={{ selected: active }}
                          aria-selected={active}
                          style={({ pressed }) => [
                            styles.railButton,
                            active && styles.railButtonActive,
                            pressed && styles.railButtonPressed,
                          ]}
                        >
                          <HarnessLogo harness={candidate.harness.id} size={18} />
                        </Pressable>
                      );
                    })}
                  </ScrollView>
                ) : null}
                <ScrollView
                  style={styles.list}
                  contentContainerStyle={styles.listContent}
                  keyboardShouldPersistTaps="handled"
                  bounces={false}
                >
                  {sections === null ? <Text style={styles.note}>Loading models…</Text> : null}
                  {sections !== null && tabs.length === 0 ? (
                    <Text style={styles.note}>Connect a harness or add an API key to choose a model.</Text>
                  ) : null}
                  {groups.map((group) => (
                    <View key={`${group.harness.id}:${group.section.provider.id}`}>
                      <View style={styles.groupHeader}>
                        {searching ? <HarnessLogo harness={group.harness.id} size={14} /> : null}
                        <Text style={styles.groupTitle} numberOfLines={1}>
                          {searching
                            ? `${group.harness.name} · ${group.section.provider.name}`
                            : group.section.provider.name}
                        </Text>
                      </View>
                      {group.models.map((model) => {
                        const selected = model.id === value?.id;
                        return (
                          <Pressable
                            key={model.id}
                            onPress={() => choose(model)}
                            accessibilityRole="radio"
                            accessibilityState={{ checked: selected }}
                            aria-checked={selected}
                            accessibilityLabel={`${modelDisplayName(model)}, ${group.section.provider.name}${searching ? `, ${group.harness.name}` : ""}`}
                            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
                          >
                            <View style={styles.checkSlot}>
                              {selected ? <Check size={16} color={colors.foreground} /> : null}
                            </View>
                            <Text style={styles.rowText} numberOfLines={1}>{modelDisplayName(model)}</Text>
                          </Pressable>
                        );
                      })}
                    </View>
                  ))}
                  {searching && groups.length === 0 ? (
                    <Text style={styles.note}>No model matches “{needle}”.</Text>
                  ) : null}
                </ScrollView>
              </View>
              {onManage !== undefined ? (
                <>
                  <View style={styles.divider} />
                  <Pressable
                    onPress={() => {
                      close();
                      onManage();
                    }}
                    accessibilityRole="button"
                    style={({ pressed }) => [styles.manage, pressed && styles.rowPressed]}
                  >
                    <Settings2 size={16} color={colors.mutedForeground} />
                    <Text style={styles.manageText}>Manage models</Text>
                  </Pressable>
                </>
              ) : null}
            </View>
          </KeyboardAvoidingView>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  pill: { flexShrink: 1, minWidth: 0 },
  pillText: { color: colors.mutedForeground, fontSize: 12, fontWeight: "500", flexShrink: 1 },
  modalRoot: { flex: 1, justifyContent: "flex-end" },
  backdrop: { position: "absolute", top: 0, bottom: 0, left: 0, right: 0, backgroundColor: colors.scrim },
  sheet: {
    backgroundColor: colors.secondary,
    borderTopLeftRadius: radius.xxl,
    borderTopRightRadius: radius.xxl,
    paddingHorizontal: spacing.sm,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xxl,
    ...shadows.soft,
  },
  sheetHeader: { height: SHEET_HEADER - spacing.sm, flexDirection: "row", alignItems: "center", gap: spacing.sm },
  sheetTitle: { flex: 1, color: colors.mutedForeground, fontSize: 13, fontWeight: "600", paddingHorizontal: spacing.xs },
  closeButton: { width: 36, height: 36, alignItems: "center", justifyContent: "center", borderRadius: radius.md },
  closeButtonPressed: { backgroundColor: colors.white06 },
  search: { marginBottom: spacing.xs },
  sheetBody: { flex: 1, minHeight: 0, flexDirection: "row", gap: spacing.xs },
  rail: { width: 48, flexGrow: 0, flexShrink: 0 },
  railContent: { gap: spacing.xs, paddingVertical: 2, paddingRight: spacing.xs },
  railButton: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.md,
    backgroundColor: colors.secondary,
  },
  railButtonActive: { backgroundColor: colors.white12 },
  railButtonPressed: { backgroundColor: colors.white06 },
  list: { flex: 1, minWidth: 0 },
  listContent: { paddingBottom: spacing.xs },
  groupHeader: { flexDirection: "row", alignItems: "center", gap: spacing.xs, height: LABEL_HEIGHT, paddingHorizontal: spacing.sm },
  groupTitle: { flex: 1, color: colors.mutedForeground, fontSize: 12, fontWeight: "600" },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    minHeight: ROW_MIN_HEIGHT,
    borderRadius: radius.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  rowPressed: { backgroundColor: colors.white06 },
  checkSlot: { width: 16 },
  rowText: { flex: 1, minWidth: 0, color: colors.foreground, fontSize: 15 },
  note: { color: colors.mutedForeground, fontSize: 14, paddingHorizontal: spacing.sm, paddingVertical: spacing.md },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginVertical: spacing.xs },
  manage: { flexDirection: "row", alignItems: "center", gap: spacing.sm, borderRadius: radius.md, paddingHorizontal: spacing.sm, paddingVertical: spacing.md },
  manageText: { color: colors.mutedForeground, fontSize: 14 },
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
  thinkingEndpointsSingle: { justifyContent: "center" },
});
