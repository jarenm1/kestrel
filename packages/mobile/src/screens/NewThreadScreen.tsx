import React, { useRef } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Message, Run, SendMessageBody, Task } from "@cloudagents/protocol";
import { keys, storeTask } from "@/api/queries";
import { Composer } from "@/components/Composer";
import { useApiClient } from "@/hooks/useApiClient";
import { threadTitle } from "@/lib/format";
import { useNavigation } from "@/nav/navigation";
import { colors, spacing } from "@/theme";

/**
 * Chat home: the first message creates a thread (task), sends the message to it and opens it. The thread starts with
 * no repository; the agent checks out the ones it needs. The composer sits at the bottom, above the keyboard.
 */
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
    <View style={styles.flex}>
      <View style={styles.body}>
        <Text style={styles.heading}>What should we work on?</Text>
      </View>
      <Composer
        onSend={(body) => start.mutateAsync(body)}
        pending={start.isPending}
        error={start.error}
        placeholder="Ask for anything — the agent checks out the repos it needs"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  body: { flex: 1, justifyContent: "center", padding: spacing.xl },
  heading: { color: colors.foreground, fontSize: 20, fontWeight: "600", letterSpacing: -0.3, textAlign: "center" },
});
