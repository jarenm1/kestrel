import React, { type ComponentRef, Fragment, type ReactNode, useMemo, useRef } from "react";
import {
  Image,
  KeyboardAvoidingView,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import type { Message, Run, SendMessageBody, Task, TaskStatus } from "@cloudagents/protocol";
import { createQueries, keys, upsert } from "@/api/queries";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { StatusIcon } from "@/components/ui/StatusIcon";
import { useApiClient } from "@/hooks/useApiClient";
import { useThreadArchive } from "@/hooks/useThreadArchive";
import { errorText, formatClock } from "@/lib/format";
import { colors, radius, shadows, spacing } from "@/theme";
import { Composer } from "./Composer";
import { Markdown } from "./Markdown";
import { RunPanel } from "./RunPanel";
import { RunTranscript } from "./RunTranscript";

interface Props {
  taskId: string;
  taskStatus: TaskStatus | undefined;
  messages: readonly Message[];
  runs: readonly Run[];
  output: Record<string, string[]>;
  /** Set while the thread is archived: the composer is replaced by an unarchive notice. */
  archivedTask: Task | undefined;
}

/** Within this distance of the end, new content keeps the thread scrolled to the bottom. */
const STICK_PX = 80;

/** Under a thread block: a spinner while the turn runs, and the time. Finished turns get no icon. */
function TurnFooter({ status, time }: { status: Run["status"] | undefined; time?: string }) {
  const running = status === "running";
  if (!running && !time) return null;
  return (
    <View style={styles.footer}>
      {running ? <StatusIcon status="running" size={14} /> : null}
      {time ? <Text style={styles.footerText}>{time}</Text> : null}
      {running && !time ? <Text style={styles.footerText}>Working…</Text> : null}
    </View>
  );
}

/** `children`: what hangs off a message (attachments, answer buttons), shown under its text. */
function ThreadItem({
  message,
  turn,
  hideText = false,
  children,
}: {
  message: Message;
  turn: Run["status"] | undefined;
  /** The run transcript already renders this text; only what hangs off the message stays. */
  hideText?: boolean;
  children?: ReactNode;
}) {
  switch (message.role) {
    case "user":
      return (
        <View style={styles.userWrap}>
          <View style={styles.userBubble}>
            <Text style={styles.userText} selectable>
              {message.text}
            </Text>
          </View>
          {children}
          {/* No agent reply yet: the turn's status sits under the prompt, on the agent's side. */}
          {turn ? (
            <View style={styles.agentSide}>
              <TurnFooter status={turn} />
            </View>
          ) : null}
        </View>
      );
    case "agent":
      // A duplicated message still holds attachments and answer buttons, and its footer is the running
      // indicator; only the clock goes, since the transcript's turn footer covers the finished turn.
      if (hideText && children === undefined) return <TurnFooter status={turn} />;
      return (
        <View>
          {hideText ? null : <Markdown text={message.text} />}
          {children}
          <TurnFooter status={turn} time={hideText ? undefined : formatClock(message.createdAt)} />
        </View>
      );
    case "system":
      return (
        <View style={styles.systemWrap}>
          <Text style={styles.system}>{message.text}</Text>
          {children}
          <TurnFooter status={turn} />
        </View>
      );
  }
}

/** Stands in for the composer on an archived thread: its history stays readable until it is unarchived. */
function ArchivedNotice({ task }: { task: Task }) {
  const { unarchive } = useThreadArchive();
  return (
    <View style={styles.archived}>
      <Text style={styles.archivedText}>This thread is archived. Unarchive it to send messages again.</Text>
      <Button variant="soft" size="sm" disabled={unarchive.isPending} onPress={() => unarchive.mutate(task.id)}>
        Unarchive
      </Button>
      {unarchive.error ? <Alert>{errorText(unarchive.error)}</Alert> : null}
    </View>
  );
}

export function ChatPanel({ taskId, taskStatus, messages, runs, output, archivedTask }: Props) {
  const { api } = useApiClient();
  const queryClient = useQueryClient();
  const queries = useMemo(() => createQueries(api), [api]);
  const scrollRef = useRef<ComponentRef<typeof ScrollView>>(null);
  // Follow new content only while the reader is at the end, so scrolling back through history is not yanked down.
  const atEnd = useRef(true);

  const sortedMessages = [...messages].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const sortedRuns = [...runs].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const runById = new Map(sortedRuns.map((r) => [r.id, r]));
  // Items of every run in the thread: their count says whether an agent message duplicates its transcript.
  const runItemQueries = useQueries({ queries: sortedRuns.map((run) => queries.runItems(run.id)) });
  const itemCountByRun = new Map(sortedRuns.map((run, index) => [run.id, runItemQueries[index]?.data?.length ?? 0]));
  // The last message of each run carries that turn's status.
  const lastMessageOfRun = new Map<string, string>();
  for (const m of sortedMessages) if (m.runId) lastMessageOfRun.set(m.runId, m.id);
  // The latest question with options gets answer buttons, but only while the agent is blocked waiting for one.
  const lastAsk = [...sortedMessages].reverse().find((m) => (m.options ?? []).length > 0);
  const pendingAsk = taskStatus === "needs_input" ? lastAsk : undefined;

  const send = useMutation({
    mutationFn: (body: SendMessageBody) => api.sendMessage(taskId, body),
    onSuccess: (res) => {
      atEnd.current = true;
      queryClient.setQueryData<Message[]>(keys.messages(taskId), (list) => upsert(list, res.message));
      queryClient.setQueryData<Run[]>(keys.runs(taskId), (list) => upsert(list, res.run));
    },
  });
  const cancel = useMutation({
    mutationFn: (runId: string) => api.cancelRun(runId),
    onSuccess: (run) => queryClient.setQueryData<Run[]>(keys.runs(taskId), (list) => upsert(list, run)),
  });
  const latestRun = sortedRuns.at(-1);
  const activeRun = latestRun?.status === "running" ? latestRun : undefined;

  function onScroll(e: NativeSyntheticEvent<NativeScrollEvent>) {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    atEnd.current = contentOffset.y + layoutMeasurement.height >= contentSize.height - STICK_PX;
  }

  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView
        ref={scrollRef}
        style={styles.flex}
        contentContainerStyle={styles.thread}
        onScroll={onScroll}
        scrollEventThrottle={64}
        keyboardDismissMode="interactive"
        onContentSizeChange={() => {
          if (atEnd.current) scrollRef.current?.scrollToEnd({ animated: false });
        }}
      >
        {sortedMessages.length === 0 ? (
          <Text style={styles.empty}>No messages yet. Describe what to do.</Text>
        ) : null}
        {sortedMessages.map((m) => {
          // A user message starts its run: that run's transcript follows the prompt.
          const startedRunId = m.role === "user" ? m.runId : null;
          const duplicate = m.role === "agent" && m.runId !== null && (itemCountByRun.get(m.runId) ?? 0) > 0;
          const attachments = m.attachments ?? [];
          // Attachments and answer buttons stay on the message itself, so it survives hiding its text.
          const extras = attachments.length > 0 || m.id === pendingAsk?.id;
          const turn = m.runId && lastMessageOfRun.get(m.runId) === m.id ? runById.get(m.runId)?.status : undefined;
          // While the prompt is the run's last message, its status goes under the transcript once one exists.
          const turnBelowTranscript = startedRunId !== null && (itemCountByRun.get(startedRunId) ?? 0) > 0;
          return (
            <Fragment key={m.id}>
              <ThreadItem message={m} turn={turnBelowTranscript ? undefined : turn} hideText={duplicate}>
                {extras ? (
                  <>
                    {attachments.map((a) => (
                      <Image
                        key={a.id}
                        source={api.attachmentSource(taskId, a.id)}
                        style={styles.attachment}
                        resizeMode="contain"
                        accessibilityLabel="Attachment"
                      />
                    ))}
                    {m.id === pendingAsk?.id ? (
                      <View style={styles.options}>
                        {(m.options ?? []).map((option, i) => (
                          <Button
                            key={i}
                            variant="soft"
                            size="sm"
                            disabled={send.isPending}
                            onPress={() => send.mutate({ text: option })}
                          >
                            {option}
                          </Button>
                        ))}
                      </View>
                    ) : null}
                  </>
                ) : undefined}
              </ThreadItem>
              {startedRunId !== null ? <RunTranscript runId={startedRunId} /> : null}
              {turnBelowTranscript ? <TurnFooter status={turn} /> : null}
            </Fragment>
          );
        })}
      </ScrollView>
      <RunPanel runs={sortedRuns} output={output} />
      {archivedTask ? (
        <ArchivedNotice task={archivedTask} />
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

const styles = StyleSheet.create({
  flex: { flex: 1 },
  thread: { flexGrow: 1, gap: 20, paddingHorizontal: spacing.lg, paddingVertical: spacing.lg },
  empty: { margin: "auto", color: colors.mutedForeground, fontSize: 14 },
  userWrap: { alignItems: "flex-end", gap: spacing.xs },
  userBubble: {
    maxWidth: "85%",
    borderRadius: radius.xxl,
    backgroundColor: colors.white08,
    paddingHorizontal: spacing.lg,
    paddingVertical: 10,
    ...shadows.soft,
  },
  userText: { color: colors.foreground, fontSize: 15, lineHeight: 22 },
  agentSide: { alignSelf: "flex-start" },
  systemWrap: { alignSelf: "center", alignItems: "center" },
  system: { color: colors.mutedForeground, fontSize: 12, fontStyle: "italic", textAlign: "center" },
  footer: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 6 },
  footerText: { color: colors.mutedForeground, fontSize: 11 },
  attachment: { width: 240, height: 180, marginTop: spacing.sm, borderRadius: radius.xl },
  options: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm, marginTop: spacing.md },
  archived: {
    gap: spacing.sm,
    margin: spacing.md,
    marginBottom: spacing.lg,
    padding: spacing.lg,
    borderRadius: radius.xl,
    backgroundColor: colors.background + "99",
  },
  archivedText: { color: colors.mutedForeground, fontSize: 14 },
});
