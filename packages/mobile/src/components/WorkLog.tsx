import React, { type ComponentRef, type ReactNode, useRef } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View, type StyleProp, type TextStyle } from "react-native";
import {
  Bot,
  Brain,
  Camera,
  CheckSquare,
  ChevronRight,
  FilePen,
  FileText,
  GitBranch,
  Globe,
  Image as ImageIcon,
  Keyboard,
  ListTodo,
  Loader,
  MessageSquare,
  Monitor,
  MousePointerClick,
  Search,
  Square,
  SquareTerminal,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react-native";
import {
  outputText,
  Paths,
  type EditLine,
  type ToolIcon,
  type ToolItem,
  type ToolKind,
  type ToolView,
} from "@cloudagents/protocol";
import { AttachmentImage } from "@/components/AttachmentImage";
import { LiveText } from "@/components/ui/LiveText";
import { useAutoOpen } from "@/hooks/useAutoOpen";
import { colors, fonts, radius, spacing } from "@/theme";

/** The web transcript's rows (`packages/app/src/components/WorkLog.tsx`) for React Native. */

/** The thread and run whose box serves the transcript's images. */
export interface RunSource {
  readonly taskId: string;
  readonly runId: string;
}

/** How close to the bottom (px) still counts as following the stream. */
const LIVE_EDGE_PX = 16;

const KIND_ICONS: Record<ToolKind, LucideIcon> = {
  command: SquareTerminal,
  read: FileText,
  edit: FilePen,
  search: Search,
  web: Globe,
  desktop: Monitor,
  agent: Bot,
  plan: ListTodo,
  other: Wrench,
};

const EXTRA_ICONS: Record<ToolIcon, LucideIcon> = {
  camera: Camera,
  pointer: MousePointerClick,
  keyboard: Keyboard,
  git: GitBranch,
  message: MessageSquare,
};

/** A tappable one-line header: icon, label, trailing marks and a chevron that turns while open. */
function RowHeader({
  icon: Icon,
  iconColor = colors.mutedForeground,
  open,
  onPress,
  children,
}: {
  icon: LucideIcon;
  iconColor?: string;
  open: boolean;
  onPress: () => void;
  children: ReactNode;
}) {
  return (
    <Pressable
      style={styles.row}
      onPress={onPress}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
    >
      <Icon size={16} color={iconColor} />
      {children}
      <View style={open ? styles.chevronOpen : undefined}>
        <ChevronRight size={14} color={colors.mutedForeground} />
      </View>
    </Pressable>
  );
}

function Pre({ text, style }: { text: string; style?: StyleProp<TextStyle> }) {
  return (
    <ScrollView style={styles.pre} nestedScrollEnabled>
      <Text style={[styles.preText, style]} selectable>
        {text}
      </Text>
    </ScrollView>
  );
}

/**
 * Open while the model is thinking (the item is its stream's newest and the run is going), then folds to a
 * "Thought" line once anything follows it.
 */
export function ThinkingBlock({ text, live }: { text: string; live: boolean }) {
  const [open, toggle] = useAutoOpen(live);
  const scrollRef = useRef<ComponentRef<typeof ScrollView>>(null);
  const atLiveEdge = useRef(true);
  return (
    <View>
      <RowHeader icon={Brain} open={open} onPress={toggle}>
        <LiveText live={live} style={styles.label}>
          {live ? "Thinking" : "Thought"}
        </LiveText>
      </RowHeader>
      {open ? (
        <ScrollView
          ref={scrollRef}
          style={[styles.details, styles.thinkingScroll]}
          nestedScrollEnabled
          scrollEventThrottle={64}
          onScroll={(e) => {
            const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
            atLiveEdge.current = contentOffset.y + layoutMeasurement.height >= contentSize.height - LIVE_EDGE_PX;
          }}
          // Follows the streaming text, unless the user scrolled up to read.
          onContentSizeChange={() => {
            if (live && atLiveEdge.current) scrollRef.current?.scrollToEnd({ animated: false });
          }}
        >
          <Text style={styles.thinking} selectable>
            {text}
          </Text>
        </ScrollView>
      ) : null}
    </View>
  );
}

const DIFF_ROW: Record<EditLine["kind"], { background?: string; marker: string; markerColor: string }> = {
  add: { background: colors.success + "1a", marker: "+", markerColor: colors.success },
  del: { background: colors.destructive + "1a", marker: "-", markerColor: colors.destructive },
  context: { marker: " ", markerColor: colors.mutedForeground },
};

function EditDiff({ lines }: { lines: readonly EditLine[] }) {
  return (
    <ScrollView style={styles.pre} nestedScrollEnabled>
      {lines.map((line, index) => (
        <View key={index} style={[styles.diffLine, { backgroundColor: DIFF_ROW[line.kind].background }]}>
          <Text style={[styles.preText, styles.diffMarker, { color: DIFF_ROW[line.kind].markerColor }]}>
            {DIFF_ROW[line.kind].marker}
          </Text>
          <Text style={[styles.preText, styles.flexShrink]} selectable>
            {line.text}
          </Text>
        </View>
      ))}
    </ScrollView>
  );
}

const CHANGE_COLORS: Record<string, string> = { add: colors.success, delete: colors.destructive };

/** The full input, one more tap away: the row's summary only says what matters. */
function FullInput({ name, input }: { name: string; input: unknown }) {
  const [open, toggle] = useAutoOpen(false);
  return (
    <View style={styles.gap}>
      <Pressable onPress={toggle} hitSlop={6} accessibilityRole="button" accessibilityState={{ expanded: open }}>
        <Text style={styles.toolName}>
          {name} · {open ? "hide input" : "full input"}
        </Text>
      </Pressable>
      {open ? <Pre text={JSON.stringify(input, null, 2)} /> : null}
    </View>
  );
}

function ToolDetails({ item, view, source, nested }: { item: ToolItem; view: ToolView; source: RunSource; nested: ReactNode }) {
  const output = outputText(item.output, view.kind);
  const hasInput = typeof item.input === "object" && item.input !== null && Object.keys(item.input).length > 0;
  // An unrecognized call shows its input as is; a recognized one summarizes it, so the whole input sits one tap away.
  const inlineInput = view.kind === "other" && view.note === undefined && hasInput;
  return (
    <View style={styles.details}>
      {view.command !== undefined ? <Pre text={`$ ${view.command}`} /> : null}
      {view.note !== undefined ? <Text style={styles.note}>{view.note}</Text> : null}
      {view.diff !== undefined && view.diff.length > 0 ? <EditDiff lines={view.diff} /> : null}
      {view.changes !== undefined
        ? view.changes.map((change) => (
            <View key={`${change.kind}:${change.path}`} style={styles.change}>
              <Text style={[styles.preText, styles.changeKind, { color: CHANGE_COLORS[change.kind] ?? colors.warning }]}>
                {change.kind}
              </Text>
              <Text style={[styles.preText, styles.flexShrink]}>{change.path}</Text>
            </View>
          ))
        : null}
      {view.todos !== undefined
        ? view.todos.map((todo, index) => {
            const Icon = todo.status === "completed" ? CheckSquare : todo.status === "in_progress" ? Loader : Square;
            const done = todo.status === "completed";
            return (
              <View key={index} style={styles.todo}>
                <Icon size={14} color={done ? colors.mutedForeground : colors.foreground} />
                <Text style={[styles.todoText, done && styles.todoDone]}>{todo.text}</Text>
              </View>
            );
          })
        : null}
      {inlineInput ? <Pre text={JSON.stringify(item.input, null, 2)} /> : null}
      {/* A diff stands in for an edit's success message, but never for the error saying why it failed. */}
      {output.text !== "" && (view.diff === undefined || item.status === "error") ? (
        <Pre text={output.text} style={item.status === "error" ? styles.error : undefined} />
      ) : null}
      {(item.images ?? []).map((image) => (
        <AttachmentImage
          key={image.id}
          path={Paths.taskRunImage(source.taskId, source.runId, image.id)}
          style={styles.image}
          accessibilityLabel="Tool screenshot"
        />
      ))}
      {/* Placeholders for images the box did not keep: runs from before it kept them, or a type it cannot serve. */}
      {output.images > 0 ? (
        <View style={styles.todo}>
          <ImageIcon size={14} color={colors.mutedForeground} />
          <Text style={styles.toolName}>
            {output.images === 1 ? "Returned a screenshot" : `Returned ${output.images} screenshots`} (not kept)
          </Text>
        </View>
      ) : null}
      {nested}
      {hasInput && !inlineInput ? (
        <FullInput name={item.name} input={item.input} />
      ) : (
        <Text style={styles.toolName}>{item.name}</Text>
      )}
    </View>
  );
}

/**
 * One tool call as a single line (what it did, to what), with its input, diff and output behind a tap. A subagent
 * stays open while it runs, so its own calls show as they happen.
 */
export function ToolRow({
  item,
  view,
  source,
  running,
  nested,
}: {
  item: ToolItem;
  view: ToolView;
  source: RunSource;
  running: boolean;
  nested?: ReactNode;
}) {
  const live = running && item.status === "running";
  const [open, toggle] = useAutoOpen(view.kind === "agent" && live);
  const failed = item.status === "error";
  return (
    <View>
      <RowHeader
        icon={view.icon !== undefined ? EXTRA_ICONS[view.icon] : KIND_ICONS[view.kind]}
        iconColor={failed ? colors.destructive : colors.mutedForeground}
        open={open}
        onPress={toggle}
      >
        <LiveText live={live} style={[styles.label, view.code && styles.code, failed && styles.error]}>
          {view.label}
        </LiveText>
        {!failed && (view.added !== undefined || view.removed !== undefined) ? (
          <Text style={styles.stats}>
            <Text style={{ color: colors.success }}>+{view.added ?? 0}</Text>{" "}
            <Text style={{ color: colors.destructive }}>−{view.removed ?? 0}</Text>
          </Text>
        ) : null}
        {failed ? <X size={14} color={colors.destructive} accessibilityLabel="failed" /> : null}
      </RowHeader>
      {open ? <ToolDetails item={item} view={view} source={source} nested={nested} /> : null}
    </View>
  );
}

/**
 * Consecutive tool calls under one summary line ("Ran 3 commands, read 2 files"). Open while the calls are still
 * coming in, folded once the agent moves on. A lone call renders without the summary but through the same views, so
 * its row (and whatever the user opened in it) survives the next call turning it into a group.
 */
export function ToolGroup({
  single,
  summary,
  kinds,
  live,
  failed,
  children,
}: {
  single: boolean;
  summary: string;
  kinds: ReadonlySet<ToolKind>;
  live: boolean;
  failed: boolean;
  children: ReactNode;
}) {
  const [open, toggle] = useAutoOpen(live);
  const [only] = kinds;
  return (
    <View>
      {single ? null : (
        <RowHeader icon={kinds.size === 1 && only !== undefined ? KIND_ICONS[only] : Wrench} open={open} onPress={toggle}>
          <LiveText live={live} style={styles.label}>
            {summary}
          </LiveText>
          {failed ? <X size={14} color={colors.destructive} accessibilityLabel="a call failed" /> : null}
        </RowHeader>
      )}
      {single || open ? <View style={single ? undefined : styles.groupBody}>{children}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: spacing.sm, minHeight: 28 },
  chevronOpen: { transform: [{ rotate: "90deg" }] },
  label: { color: colors.mutedForeground, fontSize: 14, flexShrink: 1 },
  code: { fontFamily: fonts.mono, fontSize: 12 },
  error: { color: colors.destructive },
  stats: { fontFamily: fonts.mono, fontSize: 12 },
  /** Details and group bodies hang off the row's icon column. */
  details: {
    marginLeft: 7,
    marginTop: spacing.xs,
    marginBottom: 6,
    paddingLeft: spacing.md,
    borderLeftWidth: 2,
    borderLeftColor: colors.border,
    gap: spacing.sm,
  },
  groupBody: { marginLeft: 7, paddingLeft: spacing.md, borderLeftWidth: 2, borderLeftColor: colors.border },
  thinkingScroll: { maxHeight: 240 },
  thinking: { color: colors.mutedForeground, fontSize: 14, lineHeight: 20, fontStyle: "italic" },
  pre: { maxHeight: 288, backgroundColor: colors.code, borderRadius: radius.sm, paddingHorizontal: 12, paddingVertical: 8 },
  preText: { color: colors.foreground, fontFamily: fonts.mono, fontSize: 11, lineHeight: 16 },
  diffLine: { flexDirection: "row" },
  diffMarker: { width: 14 },
  flexShrink: { flexShrink: 1 },
  change: { flexDirection: "row", gap: spacing.sm },
  changeKind: { width: 48 },
  todo: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  todoText: { color: colors.foreground, fontSize: 14, flexShrink: 1 },
  todoDone: { color: colors.mutedForeground, textDecorationLine: "line-through" },
  note: { color: colors.mutedForeground, fontSize: 14, lineHeight: 20 },
  image: { width: "100%", height: 200, borderRadius: radius.sm },
  toolName: { color: colors.mutedForeground, fontFamily: fonts.mono, fontSize: 10 },
  gap: { gap: spacing.xs },
});
