import React, { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Check, ChevronDown, ChevronUp } from "lucide-react-native";
import {
  baseModelId,
  type AgentModel,
  type ModelInfo,
  type ModelProviderInfo,
} from "@cloudagents/protocol";
import { isRouteModel, modelDisplayName } from "@cloudagents/composer/models";
import { setShownModels, storedShownModels, useShownModels } from "@/hooks/useShownModels";
import { useModelCatalog } from "@/hooks/useModelCatalog";
import { ErrorLine } from "@/components/ConnectionsShared";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { colors, spacing } from "@/theme";

/** The model list scrolls past this many rows; shorter lists take their own height, as in the web menu. */
const MODEL_LIST_MAX_HEIGHT = 320;

/** Desktop's filter text: a model's display name, catalog name or id, case-insensitively. */
function matches(model: ModelInfo, query: string): boolean {
  const needle = query.trim().toLowerCase();
  return needle.length === 0 || `${modelDisplayName(model)} ${model.name} ${model.id}`.toLowerCase().includes(needle);
}

/**
 * Toggles which of the provider's models the chat's model picker offers, with a search box and a reset, matching the
 * web Connections menu. Visibility is per model: one toggle covers every harness the model supports, so the list
 * appears once rather than once per harness.
 */
export function ModelPicker({ provider }: { readonly provider: ModelProviderInfo }) {
  const { catalog, error, refreshing, refresh } = useModelCatalog();
  const models = catalog.models.filter(
    (model) => model.provider === provider.id && !isRouteModel(model)
  );
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const shown = useShownModels()[provider.id];
  const shownBase = new Set(shown.map((model) => baseModelId(model.id)));
  const shownCount = models.filter((model) => shownBase.has(model.id)).length;
  const visible = models.filter((model) => matches(model, query));

  function setOpenState(next: boolean) {
    setOpen(next);
    if (!next) setQuery("");
  }

  /** Writes the provider's whole picker list as base model ids; the chat expands each to its supported routes. */
  function toggle(id: AgentModel) {
    const next = new Set((storedShownModels(provider.id) ?? [...shownBase]).map(baseModelId));
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setShownModels(provider.id, [...next]);
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
        {`${shownCount} of ${models.length} shown`}
      </Button>
      {open ? (
        <View style={styles.list}>
          <View style={styles.listHead}>
            <Text style={styles.listTitle}>{provider.name} models in chat</Text>
            <Button
              variant="soft"
              size="sm"
              disabled={refreshing}
              onPress={() => void refresh()}
              accessibilityLabel={`Refresh ${provider.name} models`}
            >
              {refreshing ? "Refreshing…" : "Refresh models"}
            </Button>
          </View>
          {error ? <ErrorLine error={error} /> : null}
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
            {visible.map((model) => {
              const checked = shownBase.has(model.id);
              return (
                <Pressable
                  key={model.id}
                  style={styles.toggle}
                  onPress={() => toggle(model.id)}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked }}
                  accessibilityLabel={modelDisplayName(model)}
                >
                  <Text style={[styles.toggleText, checked && styles.toggleChecked]}>
                    {modelDisplayName(model)}
                  </Text>
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
  listTitle: { color: colors.mutedForeground, fontSize: 12 },
  listHead: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
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
