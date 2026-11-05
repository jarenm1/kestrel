import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { useMutation } from "@tanstack/react-query";
import { Monitor } from "lucide-react-native";
import { useAuth } from "@/auth/AuthContext";
import { SettingsPage } from "@/components/SettingsPage";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { errorText } from "@/lib/format";
import { colors, fonts, spacing } from "@/theme";

/**
 * Where this app's threads run: Kestrel's managed box, or one of the user's own boxes. Picking one switches the active
 * box for every request (as the web app's Boxes settings does); boxes are created and deleted on the web app.
 */
export function BoxesScreen() {
  const { boxes, activeBoxId, setActiveBox } = useAuth();
  const switchBox = useMutation({
    mutationFn: (boxId: string | null) => setActiveBox(boxId),
  });

  return (
    <SettingsPage
      title="Boxes"
      description="Where your threads run: Kestrel's box, or your own machine reached directly."
    >
      <View style={styles.body}>
        <Card style={styles.card}>
          <BoxRow
            name="Kestrel's box"
            detail="Hosted by Kestrel"
            active={activeBoxId === null}
            disabled={switchBox.isPending}
            onUse={() => switchBox.mutate(null)}
          />
          {boxes.map((box) => (
            <View key={box.id} style={styles.divider}>
              <BoxRow
                name={box.name}
                detail={box.url}
                active={activeBoxId === box.id}
                disabled={switchBox.isPending}
                onUse={() => switchBox.mutate(box.id)}
              />
            </View>
          ))}
          {switchBox.error ? <Alert>{errorText(switchBox.error)}</Alert> : null}
        </Card>
        <Text style={styles.hint}>Boxes are created and deleted on the web app.</Text>
      </View>
    </SettingsPage>
  );
}

function BoxRow({
  name,
  detail,
  active,
  disabled,
  onUse,
}: {
  name: string;
  detail: string;
  active: boolean;
  disabled: boolean;
  onUse: () => void;
}) {
  return (
    <View style={styles.row}>
      <View style={styles.titleBlock}>
        <View style={styles.nameRow}>
          <Monitor size={14} color={colors.mutedForeground} />
          <Text style={styles.name}>{name}</Text>
        </View>
        <Text style={styles.detail} numberOfLines={1}>
          {detail}
        </Text>
      </View>
      {active ? (
        <Badge variant="success">active</Badge>
      ) : (
        <Button variant="soft" size="sm" disabled={disabled} onPress={onUse}>
          Use
        </Button>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: spacing.lg, paddingTop: spacing.lg, gap: spacing.md },
  card: { paddingVertical: spacing.md, gap: spacing.md },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, paddingTop: spacing.md },
  row: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  titleBlock: { flex: 1, minWidth: 0 },
  nameRow: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
  name: { color: colors.foreground, fontSize: 15, fontWeight: "600" },
  detail: { color: colors.mutedForeground, fontSize: 12, fontFamily: fonts.mono, marginTop: 2 },
  hint: { color: colors.mutedForeground, fontSize: 12, paddingHorizontal: 2 },
});
