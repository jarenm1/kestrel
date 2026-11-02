/**
 * Saved settings in the browser's localStorage, since expo-secure-store has no web implementation. Only device choices
 * go here: on the web the session is the app host's HttpOnly cookie, never stored by the app.
 */
export const storage = {
  getItem: async (key: string): Promise<string | null> => localStorage.getItem(key),
  setItem: async (key: string, value: string): Promise<void> => localStorage.setItem(key, value),
  deleteItem: async (key: string): Promise<void> => localStorage.removeItem(key),
};
