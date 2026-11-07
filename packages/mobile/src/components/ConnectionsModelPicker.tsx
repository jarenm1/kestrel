import React, { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Check, ChevronDown, ChevronUp } from "lucide-react-native";
import { useQuery } from "@tanstack/react-query";
import {
  providerModels,
  type AgentModel,
  type ModelInfo,
  type ModelProviderInfo,
} from "@cloudagents/protocol";
import { isRouteModel, modelDisplayName, modelHarnessOf } from "@cloudagents/composer/models";
import { createQueries } from "@/api/queries";
import { useApiClient } from "@/hooks/useApiClient";
import { setShownModels, useShownModels } from "@/hooks/useShownModels";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { HARNESSES } from "@/lib/harnesses";
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
 * web Connections menu. Routes appear under the harness they run; a subscription row only picks native models, and a
 * route the selected box cannot launch is not offered.
 */
export function ModelPicker({
  provider,
  allowRoutes = true,
}: {
  readonly provider: ModelProviderInfo;
  readonly allowRoutes?: boolean;
}) {
  const { api } = useApiClient();
  const queries = useMemo(() => createQueries(api), [api]);
  const capabilities = useQuery(queries.capabilities());
  const modelHarnesses = capabilities.data?.modelHarnesses;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const all = providerModels(provider.id);
  const offerable = all.filter(
    (model) =>
      (allowRoutes || !isRouteModel(model)) &&
      (!isRouteModel(model) || modelHarnesses?.some((harness) => harness === modelHarnessOf(model).harness) === true)
  );
  const shown = useShownModels()[provider.id];
  const shownIds = new Set(shown.map((m) => m.id));
  const shownCount = offerable.filter((model) => shownIds.has(model.id)).length;
  const visible = offerable.filter((model) => matches(model, query));
  const groups = HARNESSES.map((harness) => ({
    harness,
    models: visible.filter((model) => modelHarnessOf(model).harness === harness.id),
  })).filter((group) => group.models.length > 0);

  function setOpenState(next: boolean) {
    setOpen(next);
    if (!next) setQuery("");
  }

  /** Writes the provider's whole picker list, keeping the catalog order and any route this row cannot show. */
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
        {`${shownCount} of ${offerable.length} shown`}
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
            {groups.map((group) => (
              <View key={group.harness.id}>
                <Text style={styles.groupTitle}>{group.harness.name}</Text>
                {group.models.map((m) => {
                  const checked = shownIds.has(m.id);
                  return (
                    <Pressable
                      key={m.id}
                      style={styles.toggle}
                      onPress={() => toggle(m.id)}
                      accessibilityRole="checkbox"
                      accessibilityState={{ checked }}
                      accessibilityLabel={`${modelDisplayName(m)}, ${group.harness.name}`}
                    >
                      <Text style={[styles.toggleText, checked && styles.toggleChecked]}>
                        {modelDisplayName(m)}
                      </Text>
                      <View style={[styles.box, checked && styles.boxChecked]}>
                        {checked ? <Check size={12} color={colors.primaryForeground} /> : null}
                      </View>
                    </Pressable>
                  );
                })}
              </View>
            ))}
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
  groupTitle: {
    color: colors.mutedForeground,
    fontSize: 12,
    fontWeight: "600",
    marginTop: spacing.xs,
    marginBottom: 2,
  },
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
