import React, { useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { GithubRepoSlug, type Message, type Run, type SendMessageBody, type Task } from "@cloudagents/protocol";
import type { ActiveBox, ApiClient } from "@/api/client";
import { boxKeys, storeTask } from "@/api/queries";
import { useAuth } from "@/auth/AuthContext";
import { useBoxOnline } from "@/components/BoxStatus";
import { Composer } from "@/components/Composer";
import { NewThreadBar } from "@/components/NewThreadBar";
import { useApiClient } from "@/hooks/useApiClient";
import { useStoredChoice } from "@/hooks/useStoredChoice";
import { repoShortName, threadTitle } from "@/lib/format";
import { useNavigation } from "@/nav/navigation";
import { colors, spacing } from "@/theme";

type StartVariables = { api: ApiClient; box: ActiveBox | null; body: SendMessageBody };

/**
 * Chat home: the first message creates a thread (task), sends the message to it and opens it. The bar under the
 * composer picks the repository and branch the thread starts in (none: the agent checks out what it needs) and,
 * for someone with a box of their own, the box it runs on, as on the web.
 */
export function NewThreadScreen() {
  const { api } = useApiClient();
  const { boxes, activeBox, activeBoxId, setActiveBox } = useAuth();
  const nav = useNavigation();
  const queryClient = useQueryClient();
  const [repo, setRepo] = useStoredChoice("kestrel.newThreadRepo", GithubRepoSlug);
  // Branch to start from; `undefined` is the repository's default branch. A different repository starts on its default.
  const [branch, setBranch] = useState<string | undefined>();
  const boxOnline = useBoxOnline();
  // The thread created by an earlier attempt, and what it was created with; a retry after a failed send reuses it
  // only while the repository, branch and box are unchanged.
  const created = useRef<{ task: Task; repo: string | undefined; branch: string | undefined; scope: string } | null>(null);

  const switchBox = useMutation({ mutationFn: (boxId: string | null) => setActiveBox(boxId) });

  // The box the send goes to travels with the call, so a response that lands after a box switch writes into the box it was sent to.
  const start = useMutation({
    mutationFn: async ({ api, body }: StartVariables) => {
      const previous = created.current;
      let task: Task;
      if (previous !== null && previous.repo === repo && previous.branch === branch && previous.scope === api.boxScope) {
        task = previous.task;
      } else if (boxOnline === false) {
        throw new Error("That box is offline. Pick another box or start it first.");
      } else {
        const checkout = repo === undefined ? {} : { checkout: { repo, ...(branch === undefined ? {} : { baseBranch: branch }) } };
        task = await api.createTask({ title: threadTitle(body.text), ...checkout });
      }
      created.current = { task, repo, branch, scope: api.boxScope };
      // The thread exists from here on, even if sending the first message fails.
      storeTask(queryClient, task, api.boxScope);
      const sent = await api.sendMessage(task.id, body);
      return { task, sent };
    },
    onSuccess: ({ task, sent }, { api, box }) => {
      const keys = boxKeys(api.boxScope);
      queryClient.setQueryData<Message[]>(keys.messages(task.id), [sent.message]);
      queryClient.setQueryData<Run[]>(keys.runs(task.id), [sent.run]);
      nav.replace({ name: "thread", taskId: task.id, box });
    },
  });

  const busy = start.isPending || switchBox.isPending;
  return (
    <View style={styles.flex}>
      <View style={styles.body}>
        <Text style={styles.heading}>What should we work on?</Text>
      </View>
      <Composer
        onSend={(body) => start.mutateAsync({ api, box: activeBox, body })}
        pending={busy}
        error={start.error ?? switchBox.error}
        repo={repo}
        onRepoChange={(next) => {
          if (next !== repo) setBranch(undefined);
          setRepo(next);
        }}
        placeholder={
          repo === undefined ? "Ask for anything — the agent checks out the repos it needs" : `Ask for anything in ${repoShortName(repo)}`
        }
        below={
          <NewThreadBar
            repo={repo}
            onRepoChange={(next) => {
              if (next !== repo) setBranch(undefined);
              setRepo(next);
            }}
            branch={branch}
            onBranchChange={setBranch}
            boxes={{ boxes, activeBoxId }}
            boxOnline={boxOnline}
            onBoxChange={(boxId) => switchBox.mutate(boxId)}
            disabled={busy}
          />
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  body: { flex: 1, justifyContent: "center", padding: spacing.xl },
  heading: { color: colors.foreground, fontSize: 20, fontWeight: "600", letterSpacing: -0.3, textAlign: "center" },
});
