import React from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "@/api/queries";
import { AuthProvider } from "@/auth/AuthContext";
import { MainNavigator } from "@/screens/MainNavigator";
import { KeyboardAvoidingView, Platform, StyleSheet } from "react-native";
import { colors } from "@/theme";

export default function App() {
  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        <KeyboardAvoidingView
          style={styles.root}
          behavior={Platform.OS === "ios" ? "padding" : "height"}
        >
          <QueryClientProvider client={queryClient}>
            <AuthProvider>
              <MainNavigator />
            </AuthProvider>
          </QueryClientProvider>
        </KeyboardAvoidingView>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.background,
  },
});

