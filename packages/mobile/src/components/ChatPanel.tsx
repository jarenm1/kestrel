import React, { useMemo, useRef } from "react";
import { ActivityIndicator, FlatList, Image, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Message, Run, SendMessageBody, TaskStatus } from "@cloudagents/protocol";
import { useApiClient } from "@/hooks/useApiClient";
import { keys, upsert } from "@/api/queries";
import { formatClock } from "@/lib/format";
import { colors, radius, spacing } from "@/theme";
import { Composer } from "./Composer";
import { RunPanel } from "./RunPanel";

interface Props {
  taskId: string;
  taskStatus: TaskStatus | undefined;
  messages: readonly Message[];
  runs: readonly Run[];
  output: Record<string, string[]>;
  archived: boolean;
  onUnarchive: () => void;
  unarchiving: boolean;
}

type RunStatus = Run["status"];

/** Status of the run that produced each turn, keyed by the turn's last message. */
function turnStatuses(messages: readonly Message[], runs: readonly Run[]): Map<string, RunStatus> {
  const runStatus = new Map(runs.map((r) => [r.id, r.status] as const));
  const lastOfRun = new Map<string, string>();
  for (const m of messages) {
    if (m.runId) lastOfRun.set(m.runId, m.id);
  }
  const turns = new Map<string, RunStatus>();
  for (const [runId, messageId] of lastOfRun) {
    const status = runStatus.get(runId);
    if (status) turns.set(messageId, status);
  }
  return turns;
}

export function ChatPanel({
  taskId,
  taskStatus,
  messages,
  runs,
  output,
  archived,
  onUnarchive,
  unarchiving,
}: Props) {
  const { api } = useApiClient();
  const queryClient = useQueryClient();
  const listRef = useRef<FlatList<Message>>(null);

  const sortedMessages = useMemo(() => [...messages].sort((a, b) => a.createdAt.localeCompare(b.createdAt)), [messages]);
  const sortedRuns = useMemo(() => [...runs].sort((a, b) => a.startedAt.localeCompare(b.startedAt)), [runs]);
  const turns = useMemo(() => turnStatuses(sortedMessages, sortedRuns), [sortedMessages, sortedRuns]);

  // Option chips belong to the latest question, and only while the task is waiting on an answer.
  const lastWithOptions = [...sortedMessages].reverse().find((m) => (m.options ?? []).length > 0);
  const askingId = taskStatus === "needs_input" ? lastWithOptions?.id : undefined;

  const latestRun = sortedRuns.at(-1);
  const activeRun = latestRun?.status === "running" ? latestRun : undefined;

  const send = useMutation({
    mutationFn: (body: SendMessageBody) => api.sendMessage(taskId, body),
    onSuccess: (sent) => {
      queryClient.setQueryData<Message[]>(keys.messages(taskId), (list) => upsert(list, sent.message));
      queryClient.setQueryData<Run[]>(keys.runs(taskId), (list) => upsert(list, sent.run));
    },
  });

  const cancel = useMutation({
    mutationFn: (runId: string) => api.cancelRun(runId),
    onSuccess: (run) => queryClient.setQueryData<Run[]>(keys.runs(taskId), (list) => upsert(list, run)),
  });

  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <FlatList
        ref={listRef}
        style={styles.flex}
        contentContainerStyle={styles.list}
        data={sortedMessages}
        keyExtractor={(m) => m.id}
        renderItem={({ item }) => (
          <MessageItem
            taskId={taskId}
            message={item}
            turn={turns.get(item.id)}
            asking={item.id === askingId}
            optionsDisabled={send.isPending}
            onOption={(text) => send.mutate({ text })}
          />
        )}
        ListEmptyComponent={<Text style={styles.empty}>No messages yet. Describe what you want done.</Text>}
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
      />
      <RunPanel taskId={taskId} runs={sortedRuns} output={output} />
      {archived ? (
        <View style={styles.archived}>
          <Text style={styles.archivedText}>This thread is archived.</Text>
          <Pressable style={styles.unarchive} onPress={onUnarchive} disabled={unarchiving}>
            <Text style={styles.unarchiveText}>{unarchiving ? "Unarchiving…" : "Unarchive"}</Text>
          </Pressable>
        </View>
      ) : (
        <Composer
          onSend={(body) => send.mutateAsync(body)}
          pending={send.isPending}
          error={send.error ?? cancel.error}
          onStop={activeRun ? () => cancel.mutate(activeRun.id) : undefined}
          stopping={cancel.isPending}
        />
      )}
    </KeyboardAvoidingView>
  );
}

interface MessageItemProps {
  taskId: string;
  message: Message;
  turn: RunStatus | undefined;
  asking: boolean;
  optionsDisabled: boolean;
  onOption: (text: string) => void;
}

function MessageItem({ taskId, message, turn, asking, optionsDisabled, onOption }: MessageItemProps) {
  const { api } = useApiClient();
  const attachments = message.attachments ?? [];

  if (message.role === "system") {
    return <Text style={styles.system}>{message.text}</Text>;
  }

  const isUser = message.role === "user";
  return (
    <View style={[styles.bubbleWrap, isUser && styles.bubbleWrapUser]}>
      <View style={[styles.bubble, isUser ? styles.bubbleUser : styles.bubbleAgent]}>
        {message.text ? <Text style={styles.bubbleText}>{message.text}</Text> : null}
        {attachments.map((a) => (
          <Image
            key={a.id}
            source={api.attachmentSource(taskId, a.id)}
            style={styles.attachment}
            resizeMode="contain"
            accessibilityLabel="Attachment"
          />
        ))}
        {asking
          ? (message.options ?? []).map((option) => (
              <Pressable
                key={option}
                style={[styles.option, optionsDisabled && styles.disabled]}
                disabled={optionsDisabled}
                onPress={() => onOption(option)}
              >
                <Text style={styles.optionText}>{option}</Text>
              </Pressable>
            ))
          : null}
      </View>
      <TurnFooter status={turn} time={formatClock(message.createdAt)} />
    </View>
  );
}

function TurnFooter({ status, time }: { status: RunStatus | undefined; time: string }) {
  const running = status === "running";
  return (
    <View style={styles.footer}>
      {running ? <ActivityIndicator size="small" color={colors.mutedForeground} /> : null}
      <Text style={styles.footerText}>{running ? `${time} · Working…` : time}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  list: { padding: spacing.md, gap: spacing.md, flexGrow: 1 },
  empty: { color: colors.mutedForeground, textAlign: "center", marginTop: spacing.xl },
  system: { color: colors.mutedForeground, fontStyle: "italic", textAlign: "center", fontSize: 13 },
  bubbleWrap: { maxWidth: "88%", gap: spacing.xs },
  bubbleWrapUser: { alignSelf: "flex-end", alignItems: "flex-end" },
  bubble: { borderRadius: radius.xl, padding: spacing.md, gap: spacing.sm },
  bubbleUser: { backgroundColor: colors.primary },
  bubbleAgent: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border },
  bubbleText: { color: colors.foreground, fontSize: 15, lineHeight: 21 },
  attachment: { width: 220, height: 160, borderRadius: radius.md },
  option: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  optionText: { color: colors.primary, fontSize: 14 },
  disabled: { opacity: 0.4 },
  footer: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  footerText: { color: colors.mutedForeground, fontSize: 12 },
  archived: {
    margin: spacing.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.xl,
    backgroundColor: colors.card,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  archivedText: { color: colors.mutedForeground, fontSize: 14 },
  unarchive: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  unarchiveText: { color: colors.foreground, fontSize: 14 },
});
