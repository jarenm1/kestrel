import * as SecureStore from "expo-secure-store";

/** Saved settings and the session id. Native: SecureStore. The web build uses `storage.web.ts`. */
export const storage = {
  getItem: (key: string): Promise<string | null> => SecureStore.getItemAsync(key),
  setItem: (key: string, value: string): Promise<void> => SecureStore.setItemAsync(key, value),
  deleteItem: (key: string): Promise<void> => SecureStore.deleteItemAsync(key),
};
