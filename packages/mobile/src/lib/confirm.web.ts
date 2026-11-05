/** The web build's confirmation: react-native-web's `Alert.alert` does nothing, so the browser's dialog asks. */
export function confirmDestructive(title: string, message: string, _action: string, onConfirm: () => void): void {
  if (window.confirm(`${title}\n\n${message}`)) onConfirm();
}
