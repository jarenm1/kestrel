import React, { useMemo, useState } from "react";
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  FlatList,
  Pressable,
  ActivityIndicator,
  RefreshControl,
  ScrollView,
} from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useApiClient } from "@/hooks/useApiClient";
import { createQueries, keys } from "@/api/queries";
import { BoxOfflineBanner, useBoxOffline } from "@/components/BoxStatus";
import { colors, radius, spacing } from "@/theme";
import type { Repo, GithubRepo } from "@/api/types";

interface Props {
  onSelectRepo: (repoId: string) => void;
}

export function ReposScreen({ onSelectRepo }: Props) {
  const { api } = useApiClient();
  const queryClient = useQueryClient();
  const queries = useMemo(() => createQueries(api), [api]);
  const offline = useBoxOffline();

  const repos = useQuery(queries.repos());
  const ghRepos = useQuery(queries.githubRepos());

  const [activeTab, setActiveTab] = useState<"cloned" | "github" | "url">("cloned");
  const [cloneUrl, setCloneUrl] = useState("");
  const [repoName, setRepoName] = useState("");

  const addRepoMutation = useMutation({
    mutationFn: (body: { url: string; name?: string }) => api.addRepo(body),
    onSuccess: (repo) => {
      void queryClient.invalidateQueries({ queryKey: keys.repos });
      onSelectRepo(repo.id);
    },
  });

  const isAdding = addRepoMutation.isPending;

  return (
    <View style={styles.container}>
      <BoxOfflineBanner />

      {/* Tabs */}
      <View style={styles.tabBar}>
        <Pressable
          style={[styles.tab, activeTab === "cloned" && styles.tabActive]}
          onPress={() => setActiveTab("cloned")}
        >
          <Text
            style={[
              styles.tabText,
              activeTab === "cloned" && styles.tabTextActive,
            ]}
          >
            My Repos ({repos.data?.length ?? 0})
          </Text>
        </Pressable>

        <Pressable
          style={[styles.tab, activeTab === "github" && styles.tabActive]}
          onPress={() => setActiveTab("github")}
        >
          <Text
            style={[
              styles.tabText,
              activeTab === "github" && styles.tabTextActive,
            ]}
          >
            Add from GitHub
          </Text>
        </Pressable>

        <Pressable
          style={[styles.tab, activeTab === "url" && styles.tabActive]}
          onPress={() => setActiveTab("url")}
        >
          <Text
            style={[
              styles.tabText,
              activeTab === "url" && styles.tabTextActive,
            ]}
          >
            Add by URL
          </Text>
        </Pressable>
      </View>

      {addRepoMutation.error && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>
            {addRepoMutation.error instanceof Error
              ? addRepoMutation.error.message
              : "Failed to clone repository"}
          </Text>
        </View>
      )}

      {/* Tab 1: Cloned repos */}
      {activeTab === "cloned" && (
        <FlatList
          data={repos.data ?? []}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl
              refreshing={repos.isFetching}
              onRefresh={() => {
                void repos.refetch();
              }}
              tintColor={colors.primary}
            />
          }
          ListEmptyComponent={
            repos.isPending ? (
              <ActivityIndicator style={styles.loader} color={colors.primary} />
            ) : repos.error ? (
              <Text style={styles.errorText}>
                {repos.error instanceof Error
                  ? repos.error.message
                  : "Failed to load repos"}
              </Text>
            ) : (
              <View style={styles.emptyState}>
                <Text style={styles.emptyTitle}>No cloned repositories</Text>
                <Text style={styles.emptySubtitle}>
                  Clone a repository from GitHub to start running agents on it.
                </Text>
                <Pressable
                  style={styles.primaryBtn}
                  onPress={() => setActiveTab("github")}
                >
                  <Text style={styles.primaryBtnText}>Browse GitHub Repos</Text>
                </Pressable>
              </View>
            )
          }
          renderItem={({ item }) => (
            <Pressable
              style={styles.repoCard}
              onPress={() => onSelectRepo(item.id)}
            >
              <View style={styles.repoCardHeader}>
                <Text style={styles.repoName}>{item.name}</Text>
                <Text style={styles.arrowText}>→</Text>
              </View>
              <Text style={styles.repoUrl} numberOfLines={1}>
                {item.url}
              </Text>
            </Pressable>
          )}
        />
      )}

      {/* Tab 2: GitHub repos picker */}
      {activeTab === "github" && (
        <FlatList
          data={ghRepos.data ?? []}
          keyExtractor={(item) => item.fullName}
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl
              refreshing={ghRepos.isFetching}
              onRefresh={() => {
                void ghRepos.refetch();
              }}
              tintColor={colors.primary}
            />
          }
          ListEmptyComponent={
            ghRepos.isPending ? (
              <ActivityIndicator style={styles.loader} color={colors.primary} />
            ) : ghRepos.error ? (
              <View style={styles.emptyState}>
                <Text style={styles.errorText}>
                  {ghRepos.error instanceof Error
                    ? ghRepos.error.message
                    : "Failed to load GitHub repositories"}
                </Text>
              </View>
            ) : (
              <Text style={styles.emptySubtitle}>
                No repositories found on your GitHub account.
              </Text>
            )
          }
          renderItem={({ item }) => (
            <Pressable
              style={[styles.repoCard, isAdding && styles.cardDisabled]}
              disabled={isAdding || offline}
              onPress={() =>
                addRepoMutation.mutate({
                  url: item.cloneUrl,
                  name: item.fullName,
                })
              }
            >
              <View style={styles.repoCardHeader}>
                <Text style={styles.repoName}>{item.fullName}</Text>
                {item.private && <Text style={styles.privatePill}>Private</Text>}
              </View>
              <Text style={styles.repoUrl} numberOfLines={1}>
                Branch: {item.defaultBranch}
              </Text>
            </Pressable>
          )}
        />
      )}

      {/* Tab 3: Add by URL */}
      {activeTab === "url" && (
        <ScrollView contentContainerStyle={styles.formContent}>
          <Text style={styles.formTitle}>Clone Any Git Repository</Text>
          <Text style={styles.formSubtitle}>
            Clones onto your cloud agent box with full isolation.
          </Text>

          <View style={styles.inputGroup}>
            <Text style={styles.inputLabel}>Git Clone URL</Text>
            <TextInput
              style={styles.textInput}
              value={cloneUrl}
              onChangeText={setCloneUrl}
              placeholder="https://github.com/org/repo.git"
              placeholderTextColor={colors.mutedForeground}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
            />
          </View>

          <View style={styles.inputGroup}>
            <Text style={styles.inputLabel}>Display Name (Optional)</Text>
            <TextInput
              style={styles.textInput}
              value={repoName}
              onChangeText={setRepoName}
              placeholder="my-repo"
              placeholderTextColor={colors.mutedForeground}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>

          <Pressable
            style={[
              styles.primaryBtn,
              (!cloneUrl.trim() || isAdding || offline) && styles.cardDisabled,
            ]}
            disabled={!cloneUrl.trim() || isAdding || offline}
            onPress={() =>
              addRepoMutation.mutate({
                url: cloneUrl.trim(),
                name: repoName.trim() || undefined,
              })
            }
          >
            {isAdding ? (
              <ActivityIndicator color={colors.primaryForeground} />
            ) : (
              <Text style={styles.primaryBtnText}>Clone Repository</Text>
            )}
          </Pressable>
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  tabBar: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.card,
    paddingHorizontal: spacing.sm,
  },
  tab: {
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    borderBottomWidth: 2,
    borderBottomColor: "transparent",
  },
  tabActive: {
    borderBottomColor: colors.primary,
  },
  tabText: {
    color: colors.mutedForeground,
    fontSize: 13,
    fontWeight: "500",
  },
  tabTextActive: {
    color: colors.foreground,
    fontWeight: "600",
  },
  list: {
    padding: spacing.lg,
    gap: spacing.sm,
  },
  loader: {
    marginTop: 40,
  },
  emptyState: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 60,
    gap: spacing.sm,
  },
  emptyTitle: {
    color: colors.foreground,
    fontSize: 16,
    fontWeight: "600",
  },
  emptySubtitle: {
    color: colors.mutedForeground,
    fontSize: 13,
    textAlign: "center",
    maxWidth: 280,
    marginBottom: spacing.md,
  },
  repoCard: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    gap: 4,
  },
  cardDisabled: {
    opacity: 0.5,
  },
  repoCardHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  repoName: {
    color: colors.foreground,
    fontSize: 15,
    fontWeight: "600",
  },
  arrowText: {
    color: colors.mutedForeground,
    fontSize: 16,
  },
  privatePill: {
    fontSize: 10,
    color: colors.warning,
    backgroundColor: colors.warning + "22",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  repoUrl: {
    color: colors.mutedForeground,
    fontSize: 12,
    fontFamily: "monospace",
  },
  errorBox: {
    backgroundColor: colors.destructive + "18",
    padding: spacing.md,
    marginHorizontal: spacing.lg,
    marginTop: spacing.md,
    borderRadius: radius.md,
  },
  errorText: {
    color: colors.destructive,
    fontSize: 13,
  },
  formContent: {
    padding: spacing.xl,
    gap: spacing.lg,
  },
  formTitle: {
    color: colors.foreground,
    fontSize: 18,
    fontWeight: "700",
  },
  formSubtitle: {
    color: colors.mutedForeground,
    fontSize: 13,
  },
  inputGroup: {
    gap: spacing.xs,
  },
  inputLabel: {
    color: colors.foreground,
    fontSize: 13,
    fontWeight: "500",
  },
  textInput: {
    backgroundColor: colors.secondary,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    color: colors.foreground,
    fontSize: 14,
  },
  primaryBtn: {
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    alignItems: "center",
  },
  primaryBtnText: {
    color: colors.primaryForeground,
    fontSize: 14,
    fontWeight: "600",
  },
});
