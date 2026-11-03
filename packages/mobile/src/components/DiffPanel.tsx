import React, { useMemo } from "react";
import { StyleSheet } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { createQueries } from "@/api/queries";
import { useApiClient } from "@/hooks/useApiClient";
import { errorText } from "@/lib/format";
import DiffViewDom from "./DiffViewDom";

/**
 * The thread's diff, drawn by the desktop's own `DiffView` (`DiffViewDom`). It polls while the agent works, so the
 * diff follows its edits; the query keeps unchanged data by identity, so an unchanged poll sends nothing new.
 */
export function DiffPanel({ taskId, running }: { taskId: string; running: boolean }) {
  const { api } = useApiClient();
  const queries = useMemo(() => createQueries(api), [api]);
  const diff = useQuery(queries.diff(taskId, running));
  return (
    <DiffViewDom
      checkouts={diff.data?.checkouts}
      error={diff.error ? errorText(diff.error) : null}
      refreshing={diff.isFetching}
      onRefresh={async () => void diff.refetch()}
      dom={{ style: styles.fill, containerStyle: styles.fill }}
    />
  );
}

const styles = StyleSheet.create({ fill: { flex: 1, backgroundColor: "transparent" } });
