import React, { useRef } from "react";
import { KeyboardAvoidingView, Platform, StyleSheet, Text, View } from "react-native";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Message, Run, SendMessageBody, Task } from "@cloudagents/protocol";
import { keys, storeTask } from "@/api/queries";
import { Composer } from "@/components/Composer";
import { ScreenHeader } from "@/components/ScreenHeader";
import { useApiClient } from "@/hooks/useApiClient";
import { threadTitle } from "@/lib/format";
import { useNavigation } from "@/nav/navigation";
import { colors, spacing } from "@/theme";

/** A thread starts without a repository; the agent checks out the repos it needs. */
export function NewThreadScreen() {
  const { api } = useApiClient();
  const nav = useNavigation();
  const queryClient = useQueryClient();
  // The thread created by an earlier attempt; a retry after a failed send reuses it instead of creating another.
  const created = useRef<Task | null>(null);

  const start = useMutation({
    mutationFn: async (body: SendMessageBody) => {
      const task = created.current ?? (await api.createTask({ title: threadTitle(body.text) }));
      created.current = task;
      // The thread exists from here on, even if sending the first message fails.
      storeTask(queryClient, task);
      const sent = await api.sendMessage(task.id, body);
      return { task, sent };
    },
    onSuccess: ({ task, sent }) => {
      queryClient.setQueryData<Message[]>(keys.messages(task.id), [sent.message]);
      queryClient.setQueryData<Run[]>(keys.runs(task.id), [sent.run]);
      nav.replace({ name: "thread", taskId: task.id });
    },
  });

  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScreenHeader title="New thread" onBack={nav.back} />
      <View style={styles.body}>
        <Text style={styles.heading}>What should we work on?</Text>
        <Text style={styles.sub}>Describe the task. The agent checks out the repositories it needs as it goes.</Text>
      </View>
      <Composer
        onSend={(body) => start.mutateAsync(body)}
        pending={start.isPending}
        error={start.error}
        placeholder="Ask for anything"
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  body: { flex: 1, justifyContent: "center", padding: spacing.xl, gap: spacing.sm },
  heading: { color: colors.foreground, fontSize: 22, fontWeight: "700", textAlign: "center" },
  sub: { color: colors.mutedForeground, fontSize: 14, textAlign: "center" },
});
