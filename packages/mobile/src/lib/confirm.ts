import { Alert } from "react-native";

/** Asks before a destructive action; `onConfirm` runs only when accepted. The web build uses `confirm.web.ts`. */
export function confirmDestructive(title: string, message: string, action: string, onConfirm: () => void): void {
  Alert.alert(title, message, [
    { text: "Cancel", style: "cancel" },
    { text: action, style: "destructive", onPress: onConfirm },
  ]);
}
