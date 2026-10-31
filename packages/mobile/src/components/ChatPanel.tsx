import React, { type ComponentRef, Fragment, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { type NativeScrollEvent, type NativeSyntheticEvent, ScrollView, StyleSheet, Text, View } from "react-native";
import { useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import type { ContextUsage, Message, Run, SendMessageBody, Task, TaskStatus } from "@cloudagents/protocol";
import { createQueries, keys, upsert } from "@/api/queries";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { StatusIcon } from "@/components/ui/StatusIcon";
import { AttachmentImage } from "@/components/AttachmentImage";
import { useApiClient } from "@/hooks/useApiClient";
import { useThreadArchive } from "@/hooks/useThreadArchive";
import { errorText, formatClock, formatElapsed } from "@/lib/format";
import { colors, fonts, radius, shadows, spacing } from "@/theme";
import { Composer } from "./Composer";
import { Markdown } from "./Markdown";
import { RunTranscript } from "./RunTranscript";

interface Props {
  taskId: string;
  taskStatus: TaskStatus | undefined;
  messages: readonly Message[];
  runs: readonly Run[];
  /** Set while the thread is archived: the composer is replaced by an unarchive notice. */
  archivedTask: Task | undefined;
  context?: ContextUsage | null | undefined;
}

/** Within this distance of the end, new content keeps the thread scrolled to the bottom. */
const STICK_PX = 80;

const ELAPSED_TICK_MS = 1000;

function Elapsed({ startedAt }: { startedAt: string }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ELAPSED_TICK_MS);
    return () => clearInterval(id);
  }, []);
  return <Text style={styles.elapsed}>{formatElapsed(Date.parse(startedAt), now)}</Text>;
}

function WorkingIndicator({ run }: { run: Run }) {
  return (
    <View style={styles.workingWrap} pointerEvents="none">
      <View style={styles.working}>
        <StatusIcon status="running" size={14} />
        <Text style={styles.workingText}>Working</Text>
        <Elapsed startedAt={run.startedAt} />
      </View>
    </View>
  );
}

/** `children`: what hangs off a message (attachments), shown under its text. */
function ThreadItem({
  message,
  hideText = false,
  children,
}: {
  message: Message;
  /** The run transcript already renders this text; only what hangs off the message stays. */
  hideText?: boolean;
  children?: ReactNode;
}) {
  switch (message.role) {
    case "user":
      return (
        <View style={styles.userWrap}>
          {/* Sent by the agent of another of the user's threads (thread_send), not typed by the user. */}
          {message.fromThread ? (
            <Text style={styles.fromThread} numberOfLines={1}>
              From the agent of {message.fromThread.title}
            </Text>
          ) : null}
          <View style={styles.userBubble}>
            <Text style={styles.userText} selectable>
              {message.text}
            </Text>
          </View>
          {children}
        </View>
      );
    case "agent":
      if (hideText && children === undefined) return null;
      return (
        <View>
          {hideText ? null : <Markdown text={message.text} />}
          {children}
          <Text style={styles.messageTime}>{formatClock(message.createdAt)}</Text>
        </View>
      );
    case "system":
      return (
        <View style={styles.systemWrap}>
          <Text style={styles.system}>{message.text}</Text>
          {children}
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

export function ChatPanel({ taskId, taskStatus, messages, runs, archivedTask, context }: Props) {
  const { api } = useApiClient();
  const queryClient = useQueryClient();
  const queries = useMemo(() => createQueries(api), [api]);
  const scrollRef = useRef<ComponentRef<typeof ScrollView>>(null);
  // Follow new content only while the reader is at the end, so scrolling back through history is not yanked down.
  const atEnd = useRef(true);

  const sortedMessages = [...messages].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  // A run's transcript follows the last user message it took: the prompt, or a later message that steered it or
  // waited in its inbox. The user's messages read first, then everything the agent did with them.
  const transcriptAfter = new Map<string, string>();
  for (const m of sortedMessages) {
    if (m.role === "user" && m.runId !== null) transcriptAfter.set(m.runId, m.id);
  }
  const sortedRuns = [...runs].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  // Items of every run in the thread: their count says whether an agent message duplicates its transcript.
  const runItemQueries = useQueries({ queries: sortedRuns.map((run) => queries.runItems(run.id)) });
  const itemCountByRun = new Map(sortedRuns.map((run, index) => [run.id, runItemQueries[index]?.data?.length ?? 0]));

  // The latest question with options gets answer choices in the composer while waiting for input.
  const lastAsk = sortedMessages.filter((m) => m.role === "agent" && m.options !== undefined).at(-1);
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
    <View style={styles.flex}>
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
          const transcriptRunId =
            m.role === "user" && m.runId !== null && transcriptAfter.get(m.runId) === m.id ? m.runId : null;
          const pending = m.id === pendingAsk?.id;
          const duplicate =
            m.role === "agent" && m.options === undefined && m.runId !== null && (itemCountByRun.get(m.runId) ?? 0) > 0;
          const attachments = pending ? [] : (m.attachments ?? []);
          return (
            <Fragment key={m.id}>
              <ThreadItem message={m} hideText={duplicate || pending}>
                {attachments.length > 0 ? (
                  <>
                    {attachments.map((a) => (
                      <AttachmentImage
                        key={a.id}
                        taskId={taskId}
                        attachmentId={a.id}
                        style={styles.attachment}
                        accessibilityLabel="Attachment"
                      />
                    ))}
                  </>
                ) : undefined}
              </ThreadItem>
              {transcriptRunId !== null ? <RunTranscript runId={transcriptRunId} /> : null}
            </Fragment>
          );
        })}
      </ScrollView>
      {activeRun ? <WorkingIndicator run={activeRun} /> : null}
      {archivedTask ? (
        <ArchivedNotice task={archivedTask} />
      ) : (
        <Composer
          taskId={taskId}
          ask={pendingAsk}
          context={context}
          activeRunId={activeRun?.id}
          activeRunProvider={activeRun?.provider}
          onSend={(body) => send.mutateAsync(body)}
          pending={send.isPending}
          error={send.error ?? cancel.error}
          onStop={activeRun ? () => cancel.mutate(activeRun.id) : undefined}
          stopping={cancel.isPending}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  thread: { flexGrow: 1, gap: 20, paddingHorizontal: spacing.lg, paddingVertical: spacing.lg },
  empty: { margin: "auto", color: colors.mutedForeground, fontSize: 14 },
  userWrap: { alignItems: "flex-end", gap: spacing.xs },
  fromThread: { maxWidth: "85%", color: colors.mutedForeground, fontSize: 11 },
  userBubble: {
    maxWidth: "85%",
    borderRadius: radius.xxl,
    backgroundColor: colors.white08,
    paddingHorizontal: spacing.lg,
    paddingVertical: 10,
    ...shadows.soft,
  },
  userText: { color: colors.foreground, fontSize: 15, lineHeight: 22 },
  messageTime: { color: colors.mutedForeground, fontSize: 11, marginTop: 6 },
  workingWrap: {
    paddingHorizontal: spacing.lg,
    paddingTop: 4,
    paddingBottom: 2,
    alignItems: "flex-start",
  },
  working: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingLeft: spacing.xs,
  },
  workingText: {
    color: colors.mutedForeground,
    fontSize: 12,
  },
  elapsed: {
    color: colors.mutedForeground,
    fontSize: 12,
    fontFamily: fonts.mono,
  },
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
