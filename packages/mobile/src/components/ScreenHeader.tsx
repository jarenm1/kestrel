import React, { type ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import { ChevronLeft } from "lucide-react-native";
import { Button } from "@/components/ui/Button";
import { colors, spacing } from "@/theme";

interface Props {
  title: string;
  /** Shows a back control when set. */
  onBack?: () => void;
  /** Trailing actions, rendered right-aligned. */
  right?: ReactNode;
}

/** Monochrome page bar: a ghost back control, the title centred, trailing actions. Sits on the page background, no card. */
export function ScreenHeader({ title, onBack, right }: Props) {
  return (
    <View style={styles.bar}>
      <View style={styles.side}>
        {onBack ? (
          <Button variant="ghost" size="icon" icon={ChevronLeft} onPress={onBack} accessibilityLabel="Back" />
        ) : null}
      </View>
      <Text style={styles.title} numberOfLines={1}>
        {title}
      </Text>
      <View style={[styles.side, styles.sideRight]}>{right}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    backgroundColor: colors.background,
  },
  side: {
    minWidth: 72,
    flexDirection: "row",
    alignItems: "center",
  },
  sideRight: {
    justifyContent: "flex-end",
    gap: spacing.md,
  },
  title: {
    flex: 1,
    textAlign: "center",
    color: colors.foreground,
    fontSize: 16,
    fontWeight: "600",
  },
});
