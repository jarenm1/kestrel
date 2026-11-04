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
  type ModelProvider,
  type ModelProviderInfo,
} from "@cloudagents/protocol";
import { setShownModels, useShownModels } from "@/hooks/useShownModels";
import { isApiKeyConnection } from "@/components/ConnectionsShared";
import { colors, spacing } from "@/theme";

/** Providers whose model list stays under Models even though they also take an API key. */
export const MODELS_CARD_PROVIDERS: readonly ModelProvider[] = ["anthropic", "openai"];

interface Props {
  readonly connections: readonly Connection[];
  /** `BoxCapabilities.harnesses` of the box; undefined until it answers. */
  readonly harnesses: readonly ModelProvider[] | undefined;
}

/** Per provider, the models the chat's model picker offers; the rest stay out of the way. */
export function ConnectionsModels({ connections, harnesses }: Props) {
  const connected = new Set(connectedModelProviders(connections, harnesses).map((provider) => provider.id));
  // A provider whose access is an API key shows its model list in that key's row instead.
  const apiKeyProviders = new Set(connections.filter(isApiKeyConnection).map((connection) => connection.provider));
  const rows = MODEL_PROVIDERS.filter(
    (provider) =>
      MODELS_CARD_PROVIDERS.includes(provider.id) ||
      !provider.connections.some((id) => apiKeyProviders.has(id))
  );
  return (
    <View style={styles.wrap}>
      <Text style={styles.title}>Models</Text>
      <Text style={styles.hint}>Choose which models each provider offers in the chat's model picker.</Text>
      <Card style={styles.card}>
        {rows.map((provider, i) => (
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
  return (
    <View style={[styles.row, divided && styles.divided]}>
      <View style={styles.titleBlock}>
        <Text style={styles.label}>{provider.name}</Text>
        {provider.connections.length === 0 ? (
          <Badge variant="neutral">no sign-in needed</Badge>
        ) : (
          <Badge variant={connected ? "success" : "neutral"}>
            {connected ? "connected" : "not connected"}
          </Badge>
        )}
      </View>
      {connected ? null : (
        <Text style={styles.hint}>
          {provider.connections.length === 0
            ? `${provider.name} is not installed on this box.`
            : "Connect a key or subscription above to use these."}
        </Text>
      )}
      <ModelPicker provider={provider} />
    </View>
  );
}

/** Toggles which of the provider's models the chat's model picker offers. Also used inside the connection that unlocks it. */
export function ModelPicker({ provider }: { readonly provider: ModelProviderInfo }) {
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
    <View style={styles.picker}>
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
  titleBlock: { alignItems: "flex-start", gap: spacing.xs },
  label: { color: colors.foreground, fontSize: 15, fontWeight: "600" },
  picker: { gap: spacing.xs },
  trigger: { alignSelf: "flex-start" },
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
