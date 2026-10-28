import React, { useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  Dimensions,
  Animated,
  PanResponder,
} from "react-native";
import { useTaskState } from "@/hooks/useTaskState";
import { ChatPanel } from "@/components/ChatPanel";
import { DesktopViewer } from "@/components/DesktopViewer";
import { StatusBadge } from "@/components/StatusBadge";
import { BoxOfflineBanner } from "@/components/BoxStatus";
import { colors, spacing } from "@/theme";

const SCREEN_WIDTH = Dimensions.get("window").width;
const SWIPE_THRESHOLD = SCREEN_WIDTH * 0.3;

interface Props {
  taskId: string;
  onBack: () => void;
}

/**
 * Task screen: chat is the main view. Swipe left from the right edge
 * to reveal the cloud desktop viewer. Swipe right to dismiss it.
 */
export function TaskScreen({ taskId, onBack }: Props) {
  const state = useTaskState(taskId);
  const { task } = state;
  const [desktopOpen, setDesktopOpen] = useState(false);
  const slideAnim = useRef(new Animated.Value(SCREEN_WIDTH)).current;

  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, gesture) => {
        // Detect horizontal swipes
        return Math.abs(gesture.dx) > 15 && Math.abs(gesture.dx) > Math.abs(gesture.dy);
      },
      onPanResponderMove: (_, gesture) => {
        if (desktopOpen) {
          // Swiping right to close: allow movement from 0 to SCREEN_WIDTH
          const value = Math.max(0, gesture.dx);
          slideAnim.setValue(value);
        } else {
          // Swiping left to open: allow movement from SCREEN_WIDTH towards 0
          const value = Math.max(0, SCREEN_WIDTH + gesture.dx);
          slideAnim.setValue(value);
        }
      },
      onPanResponderRelease: (_, gesture) => {
        if (desktopOpen) {
          // If swiped right past threshold, close
          if (gesture.dx > SWIPE_THRESHOLD) {
            closeDesktop();
          } else {
            openDesktop();
          }
        } else {
          // If swiped left past threshold, open
          if (gesture.dx < -SWIPE_THRESHOLD) {
            openDesktop();
          } else {
            closeDesktop();
          }
        }
      },
    })
  ).current;

  function openDesktop() {
    setDesktopOpen(true);
    Animated.spring(slideAnim, {
      toValue: 0,
      useNativeDriver: true,
      tension: 65,
      friction: 11,
    }).start();
  }

  function closeDesktop() {
    Animated.spring(slideAnim, {
      toValue: SCREEN_WIDTH,
      useNativeDriver: true,
      tension: 65,
      friction: 11,
    }).start(() => setDesktopOpen(false));
  }

  return (
    <View style={styles.container} {...panResponder.panHandlers}>
      {/* Header */}
      <View style={styles.header}>
        <Pressable onPress={onBack} style={styles.backBtn}>
          <Text style={styles.backText}>←</Text>
        </Pressable>
        <View style={styles.titleRow}>
          <Text style={styles.title} numberOfLines={1}>
            {task?.title ?? "Loading…"}
          </Text>
          {task && <StatusBadge status={task.status} />}
        </View>
        <Pressable onPress={desktopOpen ? closeDesktop : openDesktop} style={styles.desktopBtn}>
          <Text style={styles.desktopBtnText}>
            {desktopOpen ? "Chat" : "Desktop"}
          </Text>
        </Pressable>
      </View>

      <BoxOfflineBanner />

      {state.error && (
        <View style={styles.errorBar}>
          <Text style={styles.errorText}>{state.error}</Text>
        </View>
      )}

      {/* Chat panel (main view) */}
      <View style={styles.chatContainer}>
        <ChatPanel
          taskId={taskId}
          messages={state.messages}
          runs={state.runs}
          output={state.output}
        />
      </View>

      {/* Desktop viewer (slide-over from right) */}
      <Animated.View
        style={[
          styles.desktopOverlay,
          { transform: [{ translateX: slideAnim }] },
        ]}
      >
        <View style={styles.desktopHandle}>
          <View style={styles.handleBar} />
        </View>
        <DesktopViewer taskId={taskId} />
      </Animated.View>

      {/* Swipe hint (visible when desktop is closed) */}
      {!desktopOpen && (
        <View style={styles.swipeHint}>
          <Text style={styles.swipeHintText}>← Swipe for desktop</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.card,
  },
  backBtn: {
    padding: spacing.xs,
  },
  backText: {
    color: colors.primary,
    fontSize: 20,
    fontWeight: "600",
  },
  titleRow: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    minWidth: 0,
  },
  title: {
    color: colors.foreground,
    fontSize: 15,
    fontWeight: "600",
    flexShrink: 1,
  },
  desktopBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.secondary,
  },
  desktopBtnText: {
    color: colors.foreground,
    fontSize: 12,
    fontWeight: "500",
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
  chatContainer: {
    flex: 1,
  },
  desktopOverlay: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: colors.background,
    zIndex: 10,
  },
  desktopHandle: {
    alignItems: "center",
    paddingVertical: 6,
    backgroundColor: colors.card,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  handleBar: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.mutedForeground + "55",
  },
  swipeHint: {
    position: "absolute",
    right: 0,
    top: "50%",
    backgroundColor: colors.accent + "cc",
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderTopLeftRadius: 6,
    borderBottomLeftRadius: 6,
  },
  swipeHintText: {
    color: colors.mutedForeground,
    fontSize: 10,
  },
});

