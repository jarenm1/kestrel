import { useEffect, useMemo, useState } from "react";
import { Linking, StyleSheet, View } from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ThreadPullRequestAction } from "@cloudagents/protocol";
import type { PullRequestTab } from "@cloudagents/ui/pull-requests";
import { actOnPullRequest, createQueries } from "@/api/queries";
import { useApiClient } from "@/hooks/useApiClient";
import { errorText } from "@/lib/format";
import PullRequestsDom from "./PullRequestsDom";

/**
 * The thread's pull requests, in the Desktop/Diff panel: the list, or one pull request's detail. The list query stays
 * mounted while a detail is open, so its poll keeps the registry current and going back is immediate. The data lives
 * here, per box; `PullRequestsDom` only draws it.
 */
export function PullRequestsPanel({ taskId }: { taskId: string }) {
  const { api } = useApiClient();
  const queries = useMemo(() => createQueries(api), [api]);
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<{ repo: string; number: number } | null>(null);
  const [tab, setTab] = useState<PullRequestTab>("summary");
  const [actionError, setActionError] = useState<string | null>(null);

  const list = useQuery(queries.pullRequests(taskId));
  const detail = useQuery({
    ...queries.pullRequest(taskId, selected?.repo ?? "", selected?.number ?? 0),
    enabled: selected !== null,
  });
  const diff = useQuery({
    ...queries.pullRequestDiff(taskId, selected?.repo ?? "", selected?.number ?? 0),
    enabled: selected !== null && tab === "code",
  });
  const action = useMutation({
    mutationFn: (next: ThreadPullRequestAction) => actOnPullRequest(queryClient, api, taskId, next),
    onSuccess: () => setActionError(null),
    onError: (error) => setActionError(errorText(error)),
  });

  // The registry can lose a pull request between refreshes; a detail that is no longer registered goes back to the list.
  useEffect(() => {
    if (selected === null || list.data === undefined) return;
    if (!list.data.pullRequests.some((pr) => pr.repo === selected.repo && pr.number === selected.number)) {
      setSelected(null);
    }
  }, [selected, list.data]);

  async function act(next: ThreadPullRequestAction): Promise<string | null> {
    try {
      await action.mutateAsync(next);
      return null;
    } catch (error) {
      return errorText(error);
    }
  }

  return (
    <View style={styles.fill}>
      <PullRequestsDom
        selected={selected}
        pullRequests={list.data ?? null}
        listError={list.error ? errorText(list.error) : null}
        listFetching={list.isFetching}
        detail={detail.data ?? null}
        detailError={detail.error ? errorText(detail.error) : null}
        detailFetching={detail.isFetching}
        diff={diff.data ?? null}
        diffError={diff.error ? errorText(diff.error) : null}
        diffFetching={diff.isFetching}
        tab={tab}
        actionError={actionError}
        actionPending={action.isPending}
        onSelect={async (repo, number) => {
          // A different pull request opens on its summary, and its predecessor's action error does not follow it.
          setSelected({ repo, number });
          setTab("summary");
          setActionError(null);
        }}
        onBack={async () => setSelected(null)}
        onRefresh={async () => {
          void detail.refetch();
          if (tab === "code") void diff.refetch();
        }}
        onRetryList={async () => void list.refetch()}
        onTabChange={async (next) => setTab(next)}
        onRetryDiff={async () => void diff.refetch()}
        onAction={act}
        onOpenExternal={async (url) => {
          await Linking.openURL(url);
        }}
        // The shared views scroll themselves; the WebView is exactly the panel's body.
        dom={{ scrollEnabled: false, style: styles.fill, containerStyle: styles.fill }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
});
