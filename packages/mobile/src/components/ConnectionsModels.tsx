import React, { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Check, ChevronDown, ChevronUp } from "lucide-react-native";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import {
  MODEL_PROVIDERS,
  connectedModelProviders,
  providerModels,
  type AgentModel,
  type Connection,
  type ModelProviderInfo,
} from "@cloudagents/protocol";
import { setShownModels, useShownModels } from "@/hooks/useShownModels";
import { colors, spacing } from "@/theme";

interface Props {
  readonly connections: readonly Connection[];
}

/** Per provider, the models the chat's model picker offers; the rest stay out of the way. */
export function ConnectionsModels({ connections }: Props) {
  const connected = new Set(connectedModelProviders(connections).map((provider) => provider.id));
  return (
    <View style={styles.wrap}>
      <Text style={styles.title}>Models</Text>
      <Text style={styles.hint}>Choose which models each provider offers in the chat's model picker.</Text>
      <Card style={styles.card}>
        {MODEL_PROVIDERS.map((provider, i) => (
          <ModelRow key={provider.id} provider={provider} connected={connected.has(provider.id)} divided={i > 0} />
        ))}
      </Card>
    </View>
  );
}

interface RowProps {
  readonly provider: ModelProviderInfo;
  readonly connected: boolean;
  /** Skips the separator on the card's first row, which the card border already draws. */
  readonly divided: boolean;
}

function ModelRow({ provider, connected, divided }: RowProps) {
  const [open, setOpen] = useState(false);
  const all = providerModels(provider.id);
  const shown = useShownModels()[provider.id];
  const shownIds = new Set(shown.map((m) => m.id));

  /** Writes the provider's whole picker list, keeping the catalog order. */
  function toggle(id: AgentModel) {
    setShownModels(
      provider.id,
      all.filter((m) => (m.id === id ? !shownIds.has(id) : shownIds.has(m.id))).map((m) => m.id)
    );
  }

  return (
    <View style={[styles.row, divided && styles.divided]}>
      <View style={styles.head}>
        <View style={styles.titleBlock}>
          <Text style={styles.label}>{provider.name}</Text>
          <Badge variant={connected ? "success" : "neutral"}>
            {connected ? "connected" : "not connected"}
          </Badge>
        </View>
        <Button
          variant="soft"
          size="sm"
          icon={open ? ChevronUp : ChevronDown}
          style={styles.trigger}
          onPress={() => setOpen((current) => !current)}
          accessibilityLabel={`${provider.name} models shown in the chat picker`}
          active={open}
        >
          {`${shown.length} of ${all.length} shown`}
        </Button>
      </View>
      {connected ? null : (
        <Text style={styles.hint}>Connect a key or subscription above to use these.</Text>
      )}
      {open ? (
        <View style={styles.list}>
          <Text style={styles.listTitle}>{provider.name} models in chat</Text>
          {all.map((m) => {
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
          <Button variant="ghost" size="sm" style={styles.reset} onPress={() => setShownModels(provider.id, null)}>
            Reset to defaults
          </Button>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.xs },
  title: { color: colors.foreground, fontSize: 16, fontWeight: "600" },
  hint: { color: colors.mutedForeground, fontSize: 13 },
  card: {
    marginTop: spacing.sm,
    paddingVertical: 0,
    paddingHorizontal: 0,
    gap: 0,
  },
  row: {
    padding: spacing.lg,
    gap: spacing.sm,
  },
  divided: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  head: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  titleBlock: { gap: spacing.xs },
  label: { color: colors.foreground, fontSize: 15, fontWeight: "600" },
  trigger: { marginLeft: "auto" },
  list: { gap: spacing.xs, marginTop: spacing.xs },
  listTitle: { color: colors.mutedForeground, fontSize: 12, marginBottom: spacing.xs },
  toggle: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: spacing.sm,
    gap: spacing.sm,
  },
  toggleText: { color: colors.foreground, fontSize: 15 },
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
});
