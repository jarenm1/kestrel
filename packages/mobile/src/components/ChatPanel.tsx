import React, { useEffect, useMemo, useState } from "react";
import { Linking, StyleSheet, Text, View } from "react-native";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { threadChoiceRun, type AgentItem, type ContextUsage, type Message, type Run, type SendMessageBody, type Task, type TaskStatus, type UsageLimitResume } from "@cloudagents/protocol";
import type { ActiveBox } from "@/api/client";
import { createQueries, boxKeys, storeTask, upsert, type ThreadCall } from "@/api/queries";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { StatusIcon } from "@/components/ui/StatusIcon";
import { useApiClient } from "@/hooks/useApiClient";
import { useThreadArchive } from "@/hooks/useThreadArchive";
import { useTranscriptBridge } from "@/hooks/useTranscriptBridge";
import { errorText, formatElapsed } from "@/lib/format";
import { useNavigation } from "@/nav/navigation";
import { colors, fonts, radius, spacing } from "@/theme";
import { Composer } from "./Composer";
import TranscriptDom from "./TranscriptDom";
import type { SwipeDirection } from "@/lib/swipe";

interface Props {
  taskId: string;
  /** The box the thread runs on (`null`: Kestrel's relayed box); threads it links to open on the same box. */
  box: ActiveBox | null;
  taskStatus: TaskStatus | undefined;
  messages: readonly Message[];
  runs: readonly Run[];
  /** Set while the thread is archived: the composer is replaced by an unarchive notice. */
  archivedTask: Task | undefined;
  context?: ContextUsage | null | undefined;
  /** Set when the conversation's content could not load at all: shown in the transcript's place, keeping sends usable. */
  loadError: string | null;
  /** A horizontal swipe over the transcript, which the screen's own swipe gestures cannot see in the native app. */
  onSwipe: (direction: SwipeDirection) => void;
}

const ELAPSED_TICK_MS = 1000;
/** A file token is renewed this long before it expires, so an image never loads with a stale one. */
const FILE_ACCESS_MARGIN_MS = 60_000;

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

/** The thread's armed usage-limit resume, or nothing when it has none. */
function UsageLimitNotice({ task }: { task: Task | undefined }) {
  const arm = task?.usageLimitResume;
  if (task === undefined || arm === undefined) return null;
  return <ArmedUsageLimit task={task} arm={arm} />;
}

/** The same notice and per-thread toggle as the web app, in native views. */
function ArmedUsageLimit({ task, arm }: { task: Task; arm: UsageLimitResume }) {
  const { api } = useApiClient();
  const queryClient = useQueryClient();
  const toggle = useMutation({
    mutationFn: (autoResume: boolean) => api.setUsageLimitAutoResume(task.id, autoResume),
    onSuccess: (updated) => queryClient.setQueryData(boxKeys(api.boxScope).task(updated.id), updated),
  });
  const paused = !arm.autoResume;
  const at = Number.isNaN(Date.parse(arm.resetsAt))
    ? "when the limit resets"
    : new Date(arm.resetsAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  return (
    <View style={styles.limit}>
      <Text style={styles.limitTitle}>Usage limit reached</Text>
      <Text style={styles.limitText}>
        {paused
          ? `Auto-resume is off for this thread. The limit resets ${at}.`
          : `This thread resumes automatically ${at}, when the provider's limit resets.`}
      </Text>
      <Button variant="soft" size="sm" disabled={toggle.isPending} onPress={() => toggle.mutate(paused)}>
        {paused ? "Resume at reset" : "Cancel auto-resume"}
      </Button>
      {toggle.error ? <Alert>{errorText(toggle.error)}</Alert> : null}
    </View>
  );
}

/** Stands in for the composer on an archived thread: its history stays readable until it is unarchived. */
function ArchivedNotice({ task }: { task: Task }) {
  const { unarchive } = useThreadArchive();
  const { api } = useApiClient();
  return (
    <View style={styles.archived}>
      <Text style={styles.archivedText}>This thread is archived. Unarchive it to send messages again.</Text>
      <Button variant="soft" size="sm" disabled={unarchive.isPending} onPress={() => unarchive.mutate({ api, taskId: task.id })}>
        Unarchive
      </Button>
      {unarchive.error ? <Alert>{errorText(unarchive.error)}</Alert> : null}
    </View>
  );
}

/**
 * The thread's transcript (the desktop's own, in `TranscriptDom`) above the native composer. This side owns the data:
 * it reads the query cache that `useTaskState` keeps live and forwards changes across the DOM bridge.
 */
export function ChatPanel({ taskId, box, taskStatus, messages, runs, archivedTask, context, loadError, onSwipe }: Props) {
  const { api } = useApiClient();
  const nav = useNavigation();
  const queryClient = useQueryClient();
  const queries = useMemo(() => createQueries(api), [api]);
  const task = useQuery(queries.task(taskId));
  // Keep `#` references scoped to the selected repository before the agent makes its first checkout.
  const checkoutRepos = (task.data?.checkouts ?? []).map((checkout) => checkout.repo);
  const referenceRepos = checkoutRepos.length === 0 && task.data?.pickedRepo
    ? [task.data.pickedRepo]
    : checkoutRepos;
  const files = useQuery({
    queryKey: [...boxKeys(api.boxScope).box, "file-access"],
    queryFn: () => api.fileAccess(),
    refetchInterval: (query) =>
      query.state.data ? Math.max(5_000, query.state.data.expiresAt - Date.now() - FILE_ACCESS_MARGIN_MS) : false,
  });

  const sortedRuns = useMemo(() => [...runs].sort((a, b) => a.startedAt.localeCompare(b.startedAt)), [runs]);
  const runItemQueries = useQueries({ queries: sortedRuns.map((run) => queries.runItems(run.id)) });
  // Rebuilt every render; the bridge compares each run's item list, which the query cache keeps by identity.
  const runItems: Record<string, readonly AgentItem[]> = {};
  sortedRuns.forEach((run, index) => {
    const items = runItemQueries[index]?.data;
    if (items !== undefined) runItems[run.id] = items;
  });

  // The latest question with options gets answer choices in the composer while waiting for input.
  const lastAsk = [...messages]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .filter((m) => m.role === "agent" && m.options !== undefined)
    .at(-1);
  const pendingAsk = taskStatus === "needs_input" ? lastAsk : undefined;

  const bridge = useTranscriptBridge({ taskId, messages, runs, runItems, pendingAskId: pendingAsk?.id });

  const send = useMutation({
    mutationFn: ({ api, taskId, body }: ThreadCall & { body: SendMessageBody }) => api.sendMessage(taskId, body),
    onSuccess: (res, { api, taskId }) => {
      const keys = boxKeys(api.boxScope);
      queryClient.setQueryData<Message[]>(keys.messages(taskId), (list) => upsert(list, res.message));
      queryClient.setQueryData<Run[]>(keys.runs(taskId), (list) => upsert(list, res.run));
    },
  });
  const cancel = useMutation({
    mutationFn: ({ api, runId }: ThreadCall & { runId: string }) => api.cancelRun(runId),
    onSuccess: (run, { api, taskId }) =>
      queryClient.setQueryData<Run[]>(boxKeys(api.boxScope).runs(taskId), (list) => upsert(list, run)),
  });
  const fork = useMutation({
    mutationFn: ({ api, taskId, messageId }: ThreadCall & { messageId: string }) => api.forkTask(taskId, messageId),
    onSuccess: (forked, { api }) => {
      storeTask(queryClient, forked, api.boxScope);
      nav.push({ name: "thread", taskId: forked.id, box });
    },
  });
  const latestRun = sortedRuns.at(-1);
  const activeRun = latestRun?.status === "running" ? latestRun : undefined;

  return (
    <View style={styles.flex}>
      {loadError ? (
        <View accessibilityRole="alert" style={styles.loadError}>
          <Text style={styles.loadErrorText}>{loadError}</Text>
        </View>
      ) : (
        <TranscriptDom
          ref={bridge.ref}
          snapshot={bridge.snapshot}
          files={files.data ? { base: files.data.base, query: files.data.query } : null}
          onResync={async () => bridge.resync()}
          onFileError={async () => void files.refetch()}
          openExternal={async (url) => void Linking.openURL(url)}
          openThread={async (id) => nav.push({ name: "thread", taskId: id, box })}
          forkThread={async (id, messageId) => fork.mutate({ api, taskId: id, messageId })}
          onSwipe={async (direction) => onSwipe(direction)}
          dom={{ style: styles.transcript, containerStyle: styles.flex }}
        />
      )}
      <UsageLimitNotice task={task.data} />
      {fork.error ? <Alert>Could not fork the thread: {errorText(fork.error)}</Alert> : null}
      {activeRun ? <WorkingIndicator run={activeRun} /> : null}
      {archivedTask ? (
        <ArchivedNotice task={archivedTask} />
      ) : (
        <Composer
          key={taskId}
          repos={referenceRepos}
          taskId={taskId}
          ask={pendingAsk}
          context={context}
          activeRunId={activeRun?.id}
          activeRunProvider={activeRun?.provider}
          activeRunModel={activeRun?.model}
          activeRunHarness={activeRun?.harness}
          lastRun={threadChoiceRun(sortedRuns, messages)}
          onSend={(body) => send.mutateAsync({ api, taskId, body })}
          pending={send.isPending}
          error={send.error ?? cancel.error}
          onStop={activeRun ? () => cancel.mutate({ api, taskId, runId: activeRun.id }) : undefined}
          stopping={cancel.isPending}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  transcript: { flex: 1, backgroundColor: "transparent" },
  // A missing conversation is content, not a banner: centered in the transcript's place above the composer.
  loadError: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.xxl,
  },
  loadErrorText: { color: colors.mutedForeground, fontSize: 14, lineHeight: 20, textAlign: "center" },
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
  archived: {
    gap: spacing.sm,
    margin: spacing.md,
    marginBottom: spacing.lg,
    padding: spacing.lg,
    borderRadius: radius.xl,
    backgroundColor: colors.background + "99",
  },
  limit: {
    gap: spacing.sm,
    marginHorizontal: spacing.md,
    marginBottom: spacing.sm,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.warning + "40",
    borderRadius: radius.xl,
    backgroundColor: colors.warning + "1a",
  },
  limitTitle: { color: colors.foreground, fontSize: 14, fontWeight: "600" },
  limitText: { color: colors.mutedForeground, fontSize: 13 },
  archivedText: { color: colors.mutedForeground, fontSize: 14 },
});
