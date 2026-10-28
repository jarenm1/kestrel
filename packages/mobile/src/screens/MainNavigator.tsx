import React, { useMemo, useState, useEffect } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  SafeAreaView,
  StatusBar,
  Image,
  Modal,
} from "react-native";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/auth/AuthContext";
import { useApiClient } from "@/hooks/useApiClient";
import { createQueries } from "@/api/queries";
import { LoginScreen } from "@/screens/LoginScreen";
import { ReposScreen } from "@/screens/ReposScreen";
import { RepoScreen } from "@/screens/RepoScreen";
import { TaskScreen } from "@/screens/TaskScreen";
import { ConnectionsScreen } from "@/screens/ConnectionsScreen";
import { BoxPill } from "@/components/BoxStatus";
import { colors, radius, spacing } from "@/theme";

export function MainNavigator() {
  const { user, loading, signOut } = useAuth();
  const { api } = useApiClient();
  const queries = useMemo(() => createQueries(api), [api]);

  const repos = useQuery(queries.repos());
  
  const [selectedRepoId, setSelectedRepoId] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [showReposModal, setShowReposModal] = useState(false);
  const [showKeysModal, setShowKeysModal] = useState(false);

  // Auto-select first repo if none selected
  useEffect(() => {
    if (!selectedRepoId && repos.data && repos.data.length > 0) {
      setSelectedRepoId(repos.data[0].id);
    }
  }, [repos.data, selectedRepoId]);

  // Query tasks for selected repo
  const tasks = useQuery({
    ...queries.repoTasks(selectedRepoId ?? ""),
    enabled: !!selectedRepoId,
  });

  // Auto-select latest task so chat interface is the default
  useEffect(() => {
    if (!selectedTaskId && tasks.data && tasks.data.length > 0) {
      // Pick the newest task
      const latest = tasks.data[tasks.data.length - 1];
      setSelectedTaskId(latest.id);
    }
  }, [tasks.data, selectedTaskId]);

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <Text style={styles.loadingText}>Connecting to Kestrel…</Text>
      </View>
    );
  }

  if (!user) {
    return <LoginScreen />;
  }

  const activeRepo = repos.data?.find((r) => r.id === selectedRepoId);
  const activeTask = tasks.data?.find((t) => t.id === selectedTaskId);

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="light-content" />

      {/* Top Navbar */}
      <View style={styles.navBar}>
        <View style={styles.navLeft}>
          <Pressable
            style={styles.switcherBtn}
            onPress={() => setShowReposModal(true)}
          >
            <View>
              <Text style={styles.brandTitle}>
                {activeRepo ? activeRepo.name : "Kestrel"}
              </Text>
              {activeTask && (
                <Text style={styles.taskSubtitle} numberOfLines={1}>
                  {activeTask.title || activeTask.branch}
                </Text>
              )}
            </View>
            <Text style={styles.switchIcon}>▼</Text>
          </Pressable>
        </View>

        <View style={styles.navRight}>
          <BoxPill />

          <Pressable
            style={styles.keyBtn}
            onPress={() => setShowKeysModal(true)}
          >
            <Text style={styles.keyBtnText}>🔑 Keys</Text>
          </Pressable>

          {user.avatarUrl ? (
            <Image source={{ uri: user.avatarUrl }} style={styles.avatar} />
          ) : null}

          <Pressable style={styles.signOutBtn} onPress={signOut}>
            <Text style={styles.signOutText}>Exit</Text>
          </Pressable>
        </View>
      </View>

      {/* Main Screen: Default is Chatbox + Swipe to Cloud Desktop */}
      <View style={styles.screenContainer}>
        {selectedTaskId ? (
          <TaskScreen
            key={selectedTaskId}
            taskId={selectedTaskId}
            onBack={() => setShowReposModal(true)}
          />
        ) : selectedRepoId ? (
          <RepoScreen
            repoId={selectedRepoId}
            onSelectTask={(taskId) => {
              setSelectedTaskId(taskId);
              setShowReposModal(false);
            }}
            onBack={() => setShowReposModal(true)}
          />
        ) : (
          <ReposScreen
            onSelectRepo={(repoId) => {
              setSelectedRepoId(repoId);
              setShowReposModal(false);
            }}
          />
        )}
      </View>

      {/* Repos & Tasks Switcher Modal */}
      <Modal
        visible={showReposModal}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setShowReposModal(false)}
      >
        <SafeAreaView style={styles.modalSafeArea}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalHeaderTitle}>Repositories & Tasks</Text>
            <Pressable
              onPress={() => setShowReposModal(false)}
              style={styles.modalCloseBtn}
            >
              <Text style={styles.modalCloseText}>Done</Text>
            </Pressable>
          </View>
          {selectedRepoId ? (
            <RepoScreen
              repoId={selectedRepoId}
              onSelectTask={(taskId) => {
                setSelectedTaskId(taskId);
                setShowReposModal(false);
              }}
              onBack={() => setSelectedRepoId(null)}
            />
          ) : (
            <ReposScreen
              onSelectRepo={(repoId) => {
                setSelectedRepoId(repoId);
              }}
            />
          )}
        </SafeAreaView>
      </Modal>

      {/* API Keys Modal */}
      <Modal
        visible={showKeysModal}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setShowKeysModal(false)}
      >
        <SafeAreaView style={styles.modalSafeArea}>
          <ConnectionsScreen onBack={() => setShowKeysModal(false)} />
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.background,
  },
  loadingContainer: {
    flex: 1,
    backgroundColor: colors.background,
    justifyContent: "center",
    alignItems: "center",
  },
  loadingText: {
    color: colors.mutedForeground,
    fontSize: 14,
  },
  navBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: colors.card,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: spacing.xs,
  },
  navLeft: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
  },
  switcherBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    paddingVertical: 2,
    maxWidth: 180,
  },
  brandTitle: {
    color: colors.foreground,
    fontSize: 15,
    fontWeight: "700",
  },
  taskSubtitle: {
    color: colors.mutedForeground,
    fontSize: 11,
    fontFamily: "monospace",
  },
  switchIcon: {
    color: colors.mutedForeground,
    fontSize: 10,
    marginTop: 2,
  },
  navRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  keyBtn: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.sm,
    backgroundColor: colors.secondary,
    borderWidth: 1,
    borderColor: colors.border,
  },
  keyBtnText: {
    color: colors.foreground,
    fontSize: 11,
    fontWeight: "600",
  },
  avatar: {
    width: 22,
    height: 22,
    borderRadius: 11,
  },
  signOutBtn: {
    paddingHorizontal: spacing.xs + 2,
    paddingVertical: 4,
  },
  signOutText: {
    color: colors.mutedForeground,
    fontSize: 11,
  },
  screenContainer: {
    flex: 1,
  },
  modalSafeArea: {
    flex: 1,
    backgroundColor: colors.background,
  },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    backgroundColor: colors.card,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  modalHeaderTitle: {
    color: colors.foreground,
    fontSize: 16,
    fontWeight: "600",
  },
  modalCloseBtn: {
    padding: spacing.xs,
  },
  modalCloseText: {
    color: colors.primary,
    fontSize: 15,
    fontWeight: "600",
  },
});
