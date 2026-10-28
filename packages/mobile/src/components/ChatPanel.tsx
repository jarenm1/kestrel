import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  FlatList,
  Pressable,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Message, Run } from "@/api/types";
import { useApiClient } from "@/hooks/useApiClient";
import { keys, upsert } from "@/api/queries";
import { RunPanel } from "./RunPanel";
import { colors, radius, spacing } from "@/theme";

interface Props {
  taskId: string;
  messages: readonly Message[];
  runs: readonly Run[];
  output: Record<string, string[]>;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

const ROLE_STYLES: Record<string, { align: "flex-end" | "flex-start" | "center"; bg: string; border: string }> = {
  user: { align: "flex-end", bg: colors.primary + "18", border: colors.primary + "55" },
  agent: { align: "flex-start", bg: colors.card, border: colors.border },
  system: { align: "center", bg: "transparent", border: "transparent" },
};

export function ChatPanel({ taskId, messages, runs, output }: Props) {
  const { api } = useApiClient();
  const queryClient = useQueryClient();
  const [text, setText] = useState("");
  const listRef = useRef<FlatList>(null);

  const sortedMessages = [...messages].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt)
  );

  useEffect(() => {
    if (listRef.current && sortedMessages.length > 0) {
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 100);
    }
  }, [sortedMessages.length]);

  const send = useMutation({
    mutationFn: (body: string) => api.sendMessage(taskId, body),
    onSuccess: (res) => {
      queryClient.setQueryData(
        keys.messages(taskId),
        (list: Message[] | undefined) => upsert(list, res.message)
      );
      queryClient.setQueryData(
        keys.runs(taskId),
        (list: Run[] | undefined) => upsert(list, res.run)
      );
      setText("");
    },
  });

  const submit = useCallback(() => {
    const body = text.trim();
    if (body) send.mutate(body);
  }, [text, send]);

  const renderMessage = useCallback(
    ({ item: m }: { item: Message }) => {
      const style = ROLE_STYLES[m.role] ?? ROLE_STYLES.system;
      return (
        <View
          style={[
            styles.bubble,
            {
              alignSelf: style.align,
              backgroundColor: style.bg,
              borderColor: style.border,
            },
            m.role === "system" && styles.systemBubble,
          ]}
        >
          <Text style={styles.meta}>
            {m.role} · {formatTime(m.createdAt)}
          </Text>
          <Text style={[styles.messageText, m.role === "system" && styles.systemText]}>
            {m.text}
          </Text>
        </View>
      );
    },
    []
  );

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      keyboardVerticalOffset={Platform.OS === "ios" ? 100 : 0}
    >
      <FlatList
        ref={listRef}
        data={sortedMessages}
        keyExtractor={(m) => m.id}
        renderItem={renderMessage}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <Text style={styles.emptyText}>
              No messages yet. Describe what to do.
            </Text>
          </View>
        }
      />
      <RunPanel taskId={taskId} runs={[...runs].sort((a, b) => a.startedAt.localeCompare(b.startedAt))} output={output} />
      {send.error && (
        <View style={styles.errorBar}>
          <Text style={styles.errorText}>
            {send.error instanceof Error ? send.error.message : String(send.error)}
          </Text>
        </View>
      )}
      <View style={styles.composer}>
        <TextInput
          style={styles.input}
          value={text}
          onChangeText={setText}
          placeholder="Message the agent…"
          placeholderTextColor={colors.mutedForeground}
          multiline
          maxLength={10000}
          returnKeyType="send"
          blurOnSubmit
          onSubmitEditing={submit}
        />
        <Pressable
          style={[
            styles.sendBtn,
            (send.isPending || text.trim() === "") && styles.sendBtnDisabled,
          ]}
          onPress={submit}
          disabled={send.isPending || text.trim() === ""}
        >
          <Text style={styles.sendText}>
            {send.isPending ? "…" : "Send"}
          </Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  list: {
    padding: spacing.lg,
    gap: spacing.md,
    flexGrow: 1,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingVertical: 80,
  },
  emptyText: {
    color: colors.mutedForeground,
    fontSize: 14,
  },
  bubble: {
    maxWidth: "90%",
    borderRadius: radius.lg,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  systemBubble: {
    borderWidth: 0,
  },
  meta: {
    color: colors.mutedForeground,
    fontSize: 10,
    textTransform: "capitalize",
    marginBottom: 2,
  },
  messageText: {
    color: colors.foreground,
    fontSize: 14,
    lineHeight: 20,
  },
  systemText: {
    fontStyle: "italic",
    color: colors.mutedForeground,
    fontSize: 12,
  },
  errorBar: {
    backgroundColor: colors.destructive + "18",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  errorText: {
    color: colors.destructive,
    fontSize: 12,
  },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.card,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  input: {
    flex: 1,
    color: colors.foreground,
    backgroundColor: colors.background,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: 14,
    maxHeight: 100,
    minHeight: 40,
  },
  sendBtn: {
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm + 2,
    justifyContent: "center",
    alignItems: "center",
    minHeight: 40,
  },
  sendBtnDisabled: {
    opacity: 0.4,
  },
  sendText: {
    color: colors.primaryForeground,
    fontSize: 14,
    fontWeight: "600",
  },
});

