import React, { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Check, ChevronDown, ChevronUp } from "lucide-react-native";
import {
  providerModels,
  type AgentModel,
  type ModelInfo,
  type ModelProviderInfo,
} from "@cloudagents/protocol";
import { setShownModels, useShownModels } from "@/hooks/useShownModels";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { colors, spacing } from "@/theme";

/** The model list scrolls past this many rows; shorter lists take their own height, as in the web menu. */
const MODEL_LIST_MAX_HEIGHT = 320;

/** Desktop's filter text: a model's name or id, case-insensitively. */
function matches(model: ModelInfo, query: string): boolean {
  const needle = query.trim().toLowerCase();
  return needle.length === 0 || `${model.name} ${model.id}`.toLowerCase().includes(needle);
}

/**
 * Toggles which of the provider's models the chat's model picker offers, with a search box and a reset, matching the
 * web Connections menu. Used beside a harness/subscription heading and inside the API key that unlocks the provider.
 */
export function ModelPicker({ provider }: { readonly provider: ModelProviderInfo }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const all = providerModels(provider.id);
  const shown = useShownModels()[provider.id];
  const shownIds = new Set(shown.map((m) => m.id));
  const visible = all.filter((model) => matches(model, query));

  function setOpenState(next: boolean) {
    setOpen(next);
    if (!next) setQuery("");
  }

  /** Writes the provider's whole picker list, keeping the catalog order. */
  function toggle(id: AgentModel) {
    setShownModels(
      provider.id,
      all.filter((m) => (m.id === id ? !shownIds.has(id) : shownIds.has(m.id))).map((m) => m.id)
    );
  }

  return (
    <View style={styles.picker}>
      <Button
        variant="soft"
        size="sm"
        icon={open ? ChevronUp : ChevronDown}
        style={styles.trigger}
        onPress={() => setOpenState(!open)}
        accessibilityLabel={`${provider.name} models shown in the chat picker`}
        active={open}
      >
        {`${shown.length} of ${all.length} shown`}
      </Button>
      {open ? (
        <View style={styles.list}>
          <Text style={styles.listTitle}>{provider.name} models in chat</Text>
          <Input
            value={query}
            onChangeText={setQuery}
            placeholder="Search models"
            accessibilityLabel={`Search ${provider.name} models`}
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.search}
          />
          <ScrollView
            style={styles.listScroll}
            nestedScrollEnabled
            keyboardShouldPersistTaps="handled"
          >
            {visible.map((m) => {
              const checked = shownIds.has(m.id);
              return (
                <Pressable
                  key={m.id}
                  style={styles.toggle}
                  onPress={() => toggle(m.id)}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked }}
                  accessibilityLabel={m.name}
                >
                  <Text style={[styles.toggleText, checked && styles.toggleChecked]}>{m.name}</Text>
                  <View style={[styles.box, checked && styles.boxChecked]}>
                    {checked ? <Check size={12} color={colors.primaryForeground} /> : null}
                  </View>
                </Pressable>
              );
            })}
            {visible.length === 0 ? (
              <Text style={styles.empty}>{`No model matches “${query.trim()}”.`}</Text>
            ) : null}
          </ScrollView>
          <Button
            variant="ghost"
            size="sm"
            style={styles.reset}
            onPress={() => setShownModels(provider.id, null)}
          >
            Reset to defaults
          </Button>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  picker: { flexShrink: 1, gap: spacing.xs },
  trigger: { alignSelf: "flex-start", marginLeft: "auto" },
  list: {
    gap: spacing.xs,
    marginTop: spacing.xs,
    padding: spacing.sm,
    borderRadius: 12,
    backgroundColor: colors.white03,
  },
  listTitle: { color: colors.mutedForeground, fontSize: 12, marginBottom: spacing.xs },
  search: { minHeight: 36, paddingVertical: 6, fontSize: 14 },
  listScroll: { maxHeight: MODEL_LIST_MAX_HEIGHT },
  toggle: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: spacing.sm,
    gap: spacing.sm,
  },
  toggleText: { flexShrink: 1, color: colors.foreground, fontSize: 15 },
  toggleChecked: { fontWeight: "600" },
  box: {
    marginLeft: "auto",
    width: 20,
    height: 20,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  boxChecked: { backgroundColor: colors.primary, borderColor: colors.primary },
  reset: { alignSelf: "flex-start", marginTop: spacing.xs },
  empty: { color: colors.mutedForeground, fontSize: 13, paddingVertical: spacing.sm },
});
