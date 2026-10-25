import { useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback, type ReactNode } from "react";
import { PauseIcon } from "@/foundation/components/Icon/icons";
import { useSessionStore, type ToolCallView } from "@/stores/session-store";
import { useSessionsStore } from "@/stores/sessions-store";
import { useKnowledgeStore } from "@/stores/knowledge-store";
import { hydrateKnowledgeTraces } from "@/lib/knowledge-traces-client";
import { createMarkdownHostConfig } from "@/lib/markdown-host";
import { rewindExecute, rewindPoints, setCodingMode } from "@/lib/agent-client";
import {
  collectSessionArtifacts,
  findToolCall,
  type SessionArtifact,
} from "@/lib/session-artifacts";
import { ARTIFACT_CATALOG_EVENT, loadSessionDocumentArtifacts } from "@/lib/artifact-catalog";
import { MessageItem } from "./MessageItem";
import { Composer } from "./Composer";
import { PlanPanel } from "./PlanPanel";
import { RewindBar } from "./RewindBar";
import { PermissionInlineCard } from "./PermissionDialog";
import { QuestionInlineCard } from "./QuestionInlineCard";
import { ToolSidePanel, type ToolSidePanelMode } from "./ToolSidePanel";
import { FindBar, isFindHit, type FindOccurrence } from "./FindBar";
import { buildQuestionHistory, QuestionHistoryPopover } from "./QuestionHistoryPopover";
import { FileChangesPanel } from "./FileChangesPanel";
import { SubagentPanel, mergePanelItems } from "./SubagentPanel";
import { TeamStatusView } from "./TeamStatusView";
import { SessionHeader, type SessionNavigationProps, type WorkspaceTarget } from "./SessionHeader";
import type { TopbarActionsProps } from "./TopbarActions";
import { aggregateFileChanges } from "@/lib/file-changes";
import { deriveSubagents } from "@/lib/subagents";
import { deriveTeams } from "@/lib/team-derive";
import { selectPermissionForSession, usePermissionStore } from "@/stores/permission-store";
import { QueuePanel } from "./QueuePanel";
import { useMessageQueueStore } from "@/stores/message-queue-store";
import { selectQuestionForSession, useQuestionStore } from "@/stores/question-store";
import { buildTimeline } from "@/lib/timeline-utils";
import { formatAgentError, friendlyError } from "@/lib/error-format";
import { useSubagentStore } from "@/stores/subagent-store";
import { stoppedTaskLabel, type SessionControl, type SessionControlAction } from "@/lib/session-control";
import type { ModelOption } from "./ModelSelector";
import type { AgentEntry } from "@/lib/types";
import type { SlashCommandInvocation } from "@/lib/slash-commands";
import { useWorkspaceMentions } from "@/lib/use-workspace-mentions";
import { useStickToBottom } from "./use-stick-to-bottom";
import { isGlobalShortcutBlocked } from "@/lib/keyboard-scope";
import { stripAttachmentTransportContext } from "@/lib/user-message";
import { AutomationControls } from "./AutomationControls";
import { type AutomationMode } from "@/lib/automation-client";
import { useAppDialog } from "./AppDialog";
import type {
  MessageRetryKind,
  MessageRetrySendRequest,
} from "@/lib/message-retry";
import type { SubagentOpenContext, SubagentScrollRestore } from "@/lib/subagent-navigation";

type WorkspaceView = WorkspaceTarget | "tool" | "preview";
type RuntimePanelKey = "changes" | "subagents" | "teams" | "plan";
function runtimePanelKey(view: WorkspaceView | null): RuntimePanelKey | null {
  return view === "changes" || view === "subagents" || view === "teams" || view === "plan" ? view : null;
}

function historyIsBusy(state: { streaming: boolean; sendNowPending?: boolean; control?: SessionControl }): boolean {
  return state.streaming || Boolean(state.sendNowPending)
    || state.control?.phase === "pausing" || state.control?.phase === "stopping";
}

/** Center chat column: scrollable message list + composer pinned at bottom. */
export function ChatView({
  onSend,
  onSendNow,
  onCancel,
  modelId,
  modelLoading = false,
  models,
  onModelChange,
  cwd,
  onNewTask,
  onPrepareRetry,
  onRetrySend,
  onRewound,
  onForked,
  onToast,
  onSelectExpert,
  onOpenSubagentSession,
  subagentScrollRestore,
  onNavigateConnectors,
  onOpenKnowledgeBase,
  onOpenMeetingMinutes,
  onOpenOrganization,
  apiReady = true,
  setupHint,
  onOpenSettings,
  cancelling = false,
  commandRefreshKey,
  onClientSlashCommand,
  title,
  onOpenTeamGroup,
  onRename,
  sessionActions,
  navigation,
  headerLeading,
  notice,
}: {
  onSend: (
    text: string,
    attachments?: string[],
    queueItemId?: string,
  ) => boolean | void | Promise<boolean | void>;
  /** Atomically replace the active turn with this user message. */
  onSendNow?: (
    text: string,
    attachments?: string[],
    queueItemId?: string,
  ) => boolean | void | Promise<boolean | void>;
  onCancel: (action?: SessionControlAction) => boolean | void | Promise<boolean | void>;
  modelId?: string;
  modelLoading?: boolean;
  models?: ModelOption[];
  onModelChange?: (id: string) => void;
  cwd?: string;
  /** Open the new-task page; an existing session's workspace is immutable. */
  onNewTask?: () => void;
  /** Validate send prerequisites before replacing conversation history. */
  onPrepareRetry?: (sessionId: string) => boolean | Promise<boolean>;
  /** Submit the exact prompt removed by a successful answer replacement. */
  onRetrySend?: (request: MessageRetrySendRequest) => boolean | Promise<boolean>;
  /** Rewind rewrote backend history — reload the transcript. */
  onRewound?: (sessionId: string) => void | Promise<void>;
  /** Fork created a new session id — navigate to it. */
  onForked?: (newSessionId: string, sourceSessionId: string, sourceCwd?: string) => void;
  /** Surface transient feedback from the rewind/fork toolbar. */
  onToast?: (msg: string) => void;
  onSelectExpert?: (agent: AgentEntry) => void;
  /** Open the child ACP session behind a subagent record. */
  onOpenSubagentSession?: (sessionId: string, cwd: string | undefined, source: SubagentOpenContext) => void | Promise<void>;
  /** Restore the exact parent row after returning from a child session. */
  subagentScrollRestore?: SubagentScrollRestore | null;
  onNavigateConnectors?: () => void;
  onOpenKnowledgeBase?: () => void;
  onOpenMeetingMinutes?: () => void;
  onOpenOrganization?: () => void;
  /** False when this session has no configured model or usable credential. */
  apiReady?: boolean;
  setupHint?: string;
  onOpenSettings?: () => void;
  cancelling?: boolean;
  commandRefreshKey?: number;
  onClientSlashCommand?: (
    invocation: SlashCommandInvocation,
  ) => boolean | void | Promise<boolean | void>;
  /** Current persisted session title, used by export/share filenames. */
  title?: string;
  onRename?: (title: string) => Promise<void>;
  sessionActions?: Omit<TopbarActionsProps, "sessionId" | "title">;
  navigation?: SessionNavigationProps;
  headerLeading?: ReactNode;
  notice?: ReactNode;
  onOpenTeamGroup?: (team: import("@/lib/agent-client").RuntimeTeamInfo) => void;
}) {
  const messages = useSessionStore((s) => s.messages);
  const streaming = useSessionStore((s) => s.streaming);
  const sendNowPending = useSessionStore((s) => s.sendNowPending);
  const streamingMessageId = useSessionStore((s) => s.streamingMessageId);
  const error = useSessionStore((s) => s.error);
  const plan = useSessionStore((s) => s.plan);
  const planApproval = useSessionStore(s => s.planApproval);
  const planRevisionDirty = useSessionStore((s) => s.planRevisionDirty);
  const sessionId = useSessionStore((s) => s.sessionId);
  const hasVisiblePlan = Boolean(plan && (plan.entries.length > 0 || planRevisionDirty) || planApproval?.sessionId === sessionId && planApproval);
  const traceLoadError = useKnowledgeStore(state => sessionId ? state.traceLoadErrors[sessionId] : undefined);
  const agentMode = useSessionStore((s) => s.agentMode);
  const control = useSessionStore((s) => s.control);
  const awaitingQuestion = Boolean(useQuestionStore(selectQuestionForSession(sessionId)));
  const mentionCandidates = useWorkspaceMentions(cwd);
  // 会话内查找(对齐 EchoAgent chat-search)。
  const timeline = useMemo(() => buildTimeline(messages), [messages]);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findOccurrences, setFindOccurrences] = useState<FindOccurrence[]>([]);
  const [findActive, setFindActive] = useState<FindOccurrence | null>(null);
  const [questionHistoryOpen, setQuestionHistoryOpen] = useState(false);
  const [jumpTargetId, setJumpTargetId] = useState<string | null>(null);
  const questionHistoryTriggerRef = useRef<HTMLButtonElement | null>(null);
  const jumpHighlightTimerRef = useRef<number | null>(null);
  const questions = useMemo(() => buildQuestionHistory(messages), [messages]);
  const closeFind = useCallback(() => {
    setFindOpen(false);
    setFindQuery("");
    setFindOccurrences([]);
    setFindActive(null);
  }, []);
  const closeQuestionHistory = useCallback(() => setQuestionHistoryOpen(false), []);
  const openFind = useCallback(() => {
    closeQuestionHistory();
    setFindOpen(true);
  }, [closeQuestionHistory]);
  const findHitIds = useMemo(
    () => [...new Set(findOccurrences.map((occurrence) => occurrence.messageId))],
    [findOccurrences],
  );
  useLayoutEffect(() => {
    closeFind();
    closeQuestionHistory();
    setJumpTargetId(null);
    if (jumpHighlightTimerRef.current !== null) {
      window.clearTimeout(jumpHighlightTimerRef.current);
      jumpHighlightTimerRef.current = null;
    }
  }, [sessionId, closeFind, closeQuestionHistory]);
  useEffect(() => {
    if (questions.length === 0) closeQuestionHistory();
  }, [questions.length, closeQuestionHistory]);
  useEffect(() => () => {
    if (jumpHighlightTimerRef.current !== null) window.clearTimeout(jumpHighlightTimerRef.current);
  }, []);
  // 文件变更聚合面板(对齐 EchoAgent file-changes-panel)。
  // A single session-owned view prevents files, plans and runtime details stacking.
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView | null>(null);
  // A tab activation changes both the view and selection in one React batch.
  // Selection callbacks must see the view selected earlier in that batch.
  const workspaceViewRef = useRef(workspaceView);
  workspaceViewRef.current = workspaceView;
  const fileChangesOpen = workspaceView === "changes";
  const subagentsOpen = workspaceView === "subagents";
  const teamsOpen = workspaceView === "teams";
  const planOpen = workspaceView === "plan";
  const [historyAction, setHistoryAction] = useState<"rewind" | "fork" | null>(null);
  const historyDisabled = modelLoading || historyIsBusy({ streaming, sendNowPending, control });
  const modelLoadingRef = useRef(modelLoading);
  modelLoadingRef.current = modelLoading;
  // Invalidate the workflow, rather than reopening its old confirmation when
  // the next turn finishes. RewindBar also checks the live store before IPC.
  useLayoutEffect(() => {
    if (historyDisabled) setHistoryAction(null);
  }, [historyDisabled]);
  const canExecuteHistory = useCallback(() => {
    const current = useSessionStore.getState();
    return current.sessionId === sessionId && !modelLoadingRef.current && !historyIsBusy(current);
  }, [sessionId]);
  const [automationModeChanging, setAutomationModeChanging] = useState(false);
  const terminalMessage = [...messages].reverse().find(message => message.role === "assistant"
    && (!control?.promptId || message.promptId === control.promptId));
  const stoppedCategory = terminalMessage?.cancellationCategory;
  const automationMode: AutomationMode = agentMode === "browser_use" || agentMode === "computer_use"
    ? agentMode
    : "default";
  const handleAutomationModeChange = useCallback(async (nextMode: AutomationMode) => {
    if (!sessionId || automationModeChanging || nextMode === automationMode) return;
    setAutomationModeChanging(true);
    try {
      if (streaming) {
        const stopped = await onCancel("pause");
        if (stopped === false) throw new Error("暂停尚未确认，请稍后重试");
      }
      await setCodingMode(sessionId, nextMode === "default" ? "agent" : nextMode);
      // CurrentModeUpdate remains authoritative; this immediate local update
      // avoids a visible delay on runtimes that acknowledge asynchronously.
      useSessionStore.getState().setAgentMode(nextMode, sessionId);
      onToast?.(nextMode === "default"
        ? "已关闭网页和电脑操作"
        : nextMode === "browser_use"
          ? "已启用操作网页"
          : "已启用操作电脑");
    } catch (error) {
      onToast?.(`切换工具失败：${friendlyError(error)}`);
    } finally {
      setAutomationModeChanging(false);
    }
  }, [automationMode, automationModeChanging, onCancel, onToast, sessionId, streaming]);
  const handlePause = useCallback(async () => {
    if (!sessionId || !streaming) return;
    await onCancel("pause");
  }, [sessionId, streaming, onCancel]);
  const handleTextControl = useCallback(async (action: SessionControlAction) => {
    // A desktop task may be between model turns. Native cancellation still has
    // to revoke physical execution; chat streaming is not its lifecycle.
    if (!streaming && automationMode === "default") {
      onToast?.(control?.phase === "paused" ? "当前任务已暂停" : "当前任务没有正在运行的内容");
      return true;
    }
    return onCancel(action);
  }, [control?.phase, automationMode, onCancel, onToast, streaming]);
  // 按会话持久化的输入草稿:切到本会话时回填,每次输入回写 store。
  // 选 setDraft 的稳定引用做回调,避免 sessionId 变化时让 Composer 收到新函数。
  const setDraft = useSessionsStore((s) => s.setDraft);
  const draft = useSessionsStore((s) =>
    sessionId ? s.drafts[sessionId] ?? "" : ""
  );
  // Read the expert name + avatar bound to the current session (for the composer badge).
  const activeExpertName = useSessionsStore((s) => {
    if (!sessionId) return undefined;
    const entry = s.independent.find((x) => x.sessionId === sessionId);
    return entry?.expertName;
  });
  const activeExpertAvatar = useSessionsStore((s) => {
    if (!sessionId) return undefined;
    const entry = s.independent.find((x) => x.sessionId === sessionId);
    return entry?.expertAvatar;
  });

  // ---- 消息"编辑重发":把消息文本回填到输入框 ----
  const [resendText, setResendText] = useState<string | undefined>(undefined);
  const [resendAttachments, setResendAttachments] = useState<string[] | undefined>(undefined);
  const [resendNonce, setResendNonce] = useState(0);
  useLayoutEffect(() => {
    setResendText(undefined);
    setResendAttachments(undefined);
  }, [sessionId]);
  const handleEditResend = useCallback((text: string, attachments: string[]) => {
    if (!text.trim() && attachments.length === 0) return;
    setResendText(text);
    setResendAttachments(attachments);
    setResendNonce((n) => n + 1);
  }, []);

  // ---- 消息级重试：文本回复重新生成；工具轮次明确二次确认后重新执行 ----
  const [retryingSessionId, setRetryingSessionId] = useState<string | null>(null);
  const retryingSessionsRef = useRef(new Set<string>());
  const { requestConfirmation, dialog: retryDialog } = useAppDialog(sessionId);
  const performRetry = useCallback(async (kind: MessageRetryKind) => {
    if (!sessionId || streaming || retryingSessionsRef.current.has(sessionId)) return;
    const targetSessionId = sessionId;
    // Find the last user message text.
    const lastUserIndex = messages.map((message) => message.role).lastIndexOf("user");
    const lastUserMsg = lastUserIndex >= 0 ? messages[lastUserIndex] : undefined;
    if (!lastUserMsg) {
      onToast?.("没有可重试的消息");
      return;
    }
    const userText = lastUserMsg.parts
      .filter((p) => p.kind === "text")
      .map((p) => p.text)
      .join("\n");
    const userAttachments = lastUserMsg.attachments ?? [];
    if (!userText.trim() && userAttachments.length === 0) return;

    retryingSessionsRef.current.add(targetSessionId);
    setRetryingSessionId(targetSessionId);
    try {
      const prepared = await onPrepareRetry?.(targetSessionId);
      if (prepared === false) return;

      // Rewind the conversation to the last user prompt (conversation only —
      // don't touch files), which drops the assistant turn we're regenerating.
      const points = await rewindPoints(targetSessionId);
      if (points.length === 0) {
        // Only a request that failed before the Runtime produced any work can
        // be retried without a persisted turn. A completed reply must never be
        // silently appended as a duplicate user message.
        if (kind !== "retry") {
          throw new Error(
            kind === "regenerate"
              ? "暂时无法替换这条回复，原回复已保留。请稍后重试。"
              : "暂时无法安全重新执行，原执行记录已保留。请发起新任务。",
          );
        }
        const displayText = userText || "请分析附件。";
        useSessionStore.getState().discardMessagesFrom(targetSessionId, lastUserMsg.id);
        const accepted = await (onRetrySend
          ? onRetrySend({
              sessionId: targetSessionId,
              displayText,
              promptText: lastUserMsg.agentText ?? displayText,
              attachments: userAttachments,
              kind,
            })
          : onSend(displayText, userAttachments));
        if (accepted === false) {
          throw new Error("未能启动重试，请确认当前模型可用后再试。");
        }
        return;
      }
      // Prefer replay metadata so the operation targets the clicked turn. A
      // fresh live turn may not have an index yet, so use the latest point.
      const targetPoint = lastUserMsg.promptIndex === undefined
        ? points.reduce((a, b) => b.promptIndex > a.promptIndex ? b : a)
        : points.find((point) => point.promptIndex === lastUserMsg.promptIndex);
      if (!targetPoint) {
        throw new Error("无法确认要替换的回复，原回复已保留。请刷新会话后重试。");
      }
      const execution = await rewindExecute(
        targetSessionId,
        targetPoint.promptIndex,
        "conversation_only",
        true,
      );
      await onRewound?.(targetSessionId);
      const continuedInBackground = useSessionStore.getState().sessionId !== targetSessionId;
      const displayText = userText || "请分析附件。";
      const restoredTransport = execution.promptText
        ? stripAttachmentTransportContext(execution.promptText)
        : undefined;
      const restoredPromptText = restoredTransport
        && userAttachments.length > 0
        && restoredTransport.attachments.length > 0
        ? restoredTransport.text
        : execution.promptText;
      const accepted = await (onRetrySend
        ? onRetrySend({
            sessionId: targetSessionId,
            displayText,
            promptText: restoredPromptText ?? lastUserMsg.agentText ?? displayText,
            attachments: userAttachments,
            kind,
          })
        : onSend(displayText, userAttachments));
      if (accepted === false) {
        throw new Error("回复已准备重试，但当前模型未能启动。请重试本轮请求。");
      }
      if (continuedInBackground) onToast?.("已在原会话中继续执行");
    } finally {
      retryingSessionsRef.current.delete(targetSessionId);
      setRetryingSessionId((current) => current === targetSessionId ? null : current);
    }
  }, [sessionId, streaming, messages, onPrepareRetry, onRetrySend, onSend, onRewound, onToast]);

  const handleRetry = useCallback((kind: MessageRetryKind) => {
    if (kind === "reexecute") {
      const lastUserIndex = messages.map((message) => message.role).lastIndexOf("user");
      const tools = messages
        .slice(lastUserIndex + 1)
        .flatMap((message) => message.parts)
        .filter((part): part is Extract<(typeof messages)[number]["parts"][number], { kind: "tool_call" }> => (
          part.kind === "tool_call"
        ));
      const toolSummary = [...new Set(tools.map((part) => part.toolCall.title).filter(Boolean))]
        .slice(0, 3)
        .join("、");
      requestConfirmation({
        title: "重新执行本轮任务？",
        description: (
          <div className="retry-confirmation">
            <p>
              本轮使用过 {tools.length} 个工具
              {toolSummary ? `（${toolSummary}${tools.length > 3 ? "等" : ""}）` : ""}。
              重新执行可能再次修改文件、运行命令或触发外部操作。
            </p>
            <p>将从当前工作区状态开始；本轮已产生的文件修改不会被撤销。</p>
          </div>
        ),
        confirmLabel: "重新执行",
        cancelLabel: "取消",
        danger: true,
        action: () => performRetry(kind),
        onError: (error) => onToast?.(`重新执行失败：${friendlyError(error)}`),
      });
      return;
    }

    void performRetry(kind).catch((error) => {
      const action = kind === "regenerate" ? "重新生成" : "重试";
      onToast?.(`${action}失败：${friendlyError(error)}`);
    });
  }, [messages, onToast, performRetry, requestConfirmation]);

  // ---- Phase 2/3: tool detail + artifacts side panel ----
  const panelOpen = workspaceView === "tool" || workspaceView === "preview"
    || workspaceView === "artifacts" || workspaceView === "fileTree" || workspaceView === "browser";
  const panelMode: ToolSidePanelMode = panelOpen ? workspaceView as ToolSidePanelMode : "artifacts";
  const [activeTool, setActiveTool] = useState<ToolCallView | null>(null);
  const [previewPath, setPreviewPath] = useState<string | null>(null);

  const [exportArtifacts, setExportArtifacts] = useState<{ sessionId: string; items: SessionArtifact[] } | null>(null);
  useEffect(() => {
    let active = true;
    let generation = 0;
    const load = (event?: Event) => {
      // History focus changes before agent_load_session binds the native cwd.
      // The existing model/loading guard turns false only after load settles.
      if (!sessionId || modelLoading) return;
      if (event && ((event as CustomEvent).detail?.source !== "document-export"
        || (event as CustomEvent).detail?.sessionId !== sessionId)) return;
      const request = ++generation;
      void loadSessionDocumentArtifacts(sessionId).then(items => {
        if (active && request === generation) setExportArtifacts({ sessionId, items });
      }).catch(error => {
        if (active) onToast?.(`无法加载会话成果：${String(error).replace(/^Error:\s*/, "")}`);
      });
    };
    load();
    window.addEventListener(ARTIFACT_CATALOG_EVENT, load);
    return () => { active = false; window.removeEventListener(ARTIFACT_CATALOG_EVENT, load); };
  }, [sessionId, modelLoading, onToast]);
  const artifacts = useMemo(() => {
    const combined = new Map(collectSessionArtifacts(messages).map(item => [item.path, item]));
    if (exportArtifacts?.sessionId === sessionId) for (const item of exportArtifacts.items) combined.set(item.path, item);
    return [...combined.values()];
  }, [messages, exportArtifacts, sessionId]);

  // Keep active tool fresh when streaming updates status/content.
  useEffect(() => {
    if (!activeTool) return;
    const fresh = findToolCall(messages, activeTool.toolCallId);
    if (fresh && fresh !== activeTool) setActiveTool(fresh);
  }, [messages, activeTool]);

  // Close panel when switching sessions.
  useLayoutEffect(() => {
    workspaceViewRef.current = null;
    setWorkspaceView(null);
    setHistoryAction(null);
    setActiveTool(null);
    setPreviewPath(null);
  }, [sessionId]);

  useEffect(() => {
    if (subagentScrollRestore?.parentSessionId === sessionId) {
      workspaceViewRef.current = "subagents";
      setWorkspaceView("subagents");
    }
  }, [sessionId, subagentScrollRestore?.sequence]);
  const liveMap = useSubagentStore(s => sessionId ? s.bySession[sessionId] : undefined);
  const liveSubagents = useMemo(() => Object.values(liveMap ?? {}), [liveMap]);
  const derivedSubagents = useMemo(() => deriveSubagents(messages), [messages]);
  const teams = useMemo(() => deriveTeams(messages), [messages]);
  const changes = useMemo(() => aggregateFileChanges(messages), [messages]);
  const pendingPermission = usePermissionStore(selectPermissionForSession(sessionId));
  const collaboration = useMemo(() => mergePanelItems(liveSubagents, derivedSubagents), [liveSubagents, derivedSubagents]);
  const subagentCount = collaboration.length;
  const searchable = messages.some(m => m.parts.some(p => p.kind === "text" && p.text.trim()));
  const hasContent = messages.some(m => m.parts.length > 0 || m.attachments?.length);
  const awaitingPlan = planApproval?.sessionId === sessionId;
  const failed = !streaming && terminalMessage?.stopReason === "error";
  const status = pendingPermission ? "等待审批" : awaitingPlan ? "等待计划确认" : awaitingQuestion ? "等待回答"
    : control?.phase === "pausing" ? "正在暂停" : control?.phase === "paused" ? "已暂停"
    : control?.phase === "stopping" ? "正在停止" : control?.phase === "stopped" ? "已停止"
    : error || failed ? "任务出错" : streaming ? "进行中" : undefined;

  const markdownConfig = useMemo(
    () =>
      createMarkdownHostConfig({
        cwd,
        sessionId,
        onToast,
      }),
    [cwd, sessionId, onToast],
  );

  const {
    scrollRef,
    contentRef,
    following,
    pauseFollowing,
    scrollToBottom,
  } = useStickToBottom({
    contentVersion: messages,
    streaming,
    sessionId,
  });
  const runtimeScrollRestore = useRef<{ sessionId: string | null; top: number; following: boolean } | null>(null);
  const pendingRuntimeScroll = useRef<{ sessionId: string | null; key: RuntimePanelKey; opening: boolean } | null>(null);
  useLayoutEffect(() => {
    // ChatView stays mounted when selecting another conversation. Its old
    // panel positions must never override the new conversation's follow state.
    runtimeScrollRestore.current = null;
    pendingRuntimeScroll.current = null;
  }, [sessionId]);
  const transitionWorkspace = useCallback((next: WorkspaceView | null) => {
    closeQuestionHistory();
    const previous = workspaceViewRef.current;
    if (next === previous) return;
    workspaceViewRef.current = next;
    const previousRuntime = runtimePanelKey(previous);
    const nextRuntime = runtimePanelKey(next);
    if (nextRuntime) {
      if (!previousRuntime) {
        runtimeScrollRestore.current = { sessionId, top: scrollRef.current?.scrollTop ?? 0, following };
      }
      pauseFollowing();
      pendingRuntimeScroll.current = { sessionId, key: nextRuntime, opening: true };
    } else if (previousRuntime) {
      pendingRuntimeScroll.current = { sessionId, key: previousRuntime, opening: false };
    }
    setWorkspaceView(next);
  }, [closeQuestionHistory, sessionId, following, scrollRef, pauseFollowing]);
  useLayoutEffect(() => {
    const pending = pendingRuntimeScroll.current;
    const viewport = scrollRef.current;
    if (!pending || pending.sessionId !== sessionId || !viewport) return;
    pendingRuntimeScroll.current = null;
    if (pending.opening) {
      const anchor = viewport.querySelector<HTMLElement>(`[data-runtime-panel-anchor="${pending.key}"]`);
      if (anchor) viewport.scrollTop += anchor.getBoundingClientRect().top - viewport.getBoundingClientRect().top - 8;
      return;
    }
    const restore = runtimeScrollRestore.current;
    runtimeScrollRestore.current = null;
    if (!restore || restore.sessionId !== sessionId) {
      // An inherited/automatically opened panel has no reading position to
      // restore. Keep following instead of treating its removal as a scroll up.
      if (following) scrollToBottom();
      return;
    }
    if (restore.following) scrollToBottom();
    else {
      pauseFollowing();
      viewport.scrollTop = restore.top;
    }
  }, [sessionId, workspaceView, fileChangesOpen, subagentsOpen, teamsOpen, planOpen, following, pauseFollowing, scrollRef, scrollToBottom]);

  const handleOpenTool = useCallback((tc: ToolCallView) => {
    setActiveTool(tc);
    setPreviewPath(null);
    transitionWorkspace("tool");
  }, [transitionWorkspace]);
  const handleSelectArtifact = useCallback((artifact: SessionArtifact) => {
    setPreviewPath(artifact.path);
    const current = workspaceViewRef.current;
    transitionWorkspace(current === "artifacts" || current === "fileTree" ? current : "preview");
  }, [transitionWorkspace]);
  const handleOpenArtifacts = useCallback(() => transitionWorkspace("artifacts"), [transitionWorkspace]);

  const jumpToQuestion = useCallback((messageId: string) => {
    const row = Array.from(scrollRef.current?.querySelectorAll<HTMLElement>("[data-msg-id]") ?? [])
      .find((node) => node.dataset.msgId === messageId);
    closeQuestionHistory();
    if (!row) return;
    pauseFollowing();
    if (jumpHighlightTimerRef.current !== null) window.clearTimeout(jumpHighlightTimerRef.current);
    setJumpTargetId(messageId);
    row.focus({ preventScroll: true });
    row.scrollIntoView?.({ behavior: "smooth", block: "center" });
    jumpHighlightTimerRef.current = window.setTimeout(() => {
      setJumpTargetId(null);
      jumpHighlightTimerRef.current = null;
    }, 2200);
  }, [closeQuestionHistory, pauseFollowing, scrollRef]);

  const restoredSequenceRef = useRef<number | null>(null);
  const restoreSubagentRow = useCallback((key: string) => {
    if (!subagentScrollRestore || subagentScrollRestore.parentSessionId !== sessionId
      || restoredSequenceRef.current === subagentScrollRestore.sequence) return;
    const viewport = scrollRef.current;
    const row = Array.from(viewport?.querySelectorAll<HTMLElement>("[data-subagent-key]") ?? [])
      .find((node) => node.dataset.subagentKey === key);
    if (!viewport || !row) return;
    pauseFollowing();
    const actualOffset = row.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
    viewport.scrollTop += actualOffset - subagentScrollRestore.rowOffset;
    restoredSequenceRef.current = subagentScrollRestore.sequence;
  }, [pauseFollowing, scrollRef, sessionId, subagentScrollRestore]);

  useLayoutEffect(() => {
    if (!subagentScrollRestore || subagentScrollRestore.parentSessionId !== sessionId
      || restoredSequenceRef.current === subagentScrollRestore.sequence) return;
    const viewport = scrollRef.current;
    if (!viewport) return;
    // The transcript may still be replaying. Preserve the old position first,
    // then refine it to the row once the subagent list is rendered.
    pauseFollowing();
    viewport.scrollTop = subagentScrollRestore.scrollTop;
    restoreSubagentRow(subagentScrollRestore.subagentKey);
  }, [messages, pauseFollowing, restoreSubagentRow, scrollRef, sessionId, subagentScrollRestore]);

  const openSubagentSession = useCallback((childSessionId: string, childCwd: string | undefined, subagentKey: string) => {
    if (!sessionId || !onOpenSubagentSession) return;
    const viewport = scrollRef.current;
    const row = Array.from(viewport?.querySelectorAll<HTMLElement>("[data-subagent-key]") ?? [])
      .find((node) => node.dataset.subagentKey === subagentKey);
    const rowOffset = viewport && row
      ? row.getBoundingClientRect().top - viewport.getBoundingClientRect().top
      : 0;
    return onOpenSubagentSession(childSessionId, childCwd, {
      parentSessionId: sessionId,
      parentCwd: cwd,
      subagentKey,
      scrollTop: viewport?.scrollTop ?? 0,
      rowOffset,
    });
  }, [cwd, onOpenSubagentSession, scrollRef, sessionId]);

  // 会话内查找:Ctrl/Cmd+F 打开。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        if (isGlobalShortcutBlocked()) return;
        if (messages.length > 0) {
          e.preventDefault();
          openFind();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [messages.length, openFind]);
  // Markdown 和用户消息都完成渲染后，从实际 mark 收集唯一可信的命中顺序。
  useLayoutEffect(() => {
    if (!findOpen || !findQuery) {
      setFindOccurrences([]);
      return;
    }
    const next: FindOccurrence[] = [];
    scrollRef.current?.querySelectorAll<HTMLElement>("[data-msg-id]").forEach((messageNode) => {
      const messageId = messageNode.dataset.msgId;
      if (!messageId) return;
      messageNode.querySelectorAll(".find-hit").forEach((_, localIndex) => {
        next.push({ messageId, localIndex });
      });
    });
    setFindOccurrences(next);
  }, [findOpen, findQuery, messages]);

  // 激活样式和滚动都落到具体命中，避免多命中消息只滚到容器顶部。
  // 滚动行为区分两种场景:query 变化(立即跳) 与 Enter 上下切换(平滑滚),
  // 避免快速键击时动画叠加导致定位漂移。
  const findPrevQueryRef = useRef(findQuery);
  useEffect(() => {
    const root = scrollRef.current;
    root?.querySelectorAll(".find-hit-active").forEach((node) => {
      node.classList.remove("find-hit-active");
    });
    // Query changes clear the active occurrence until the freshly rendered
    // marks have been collected. Do not mark the query as handled yet, or the
    // first real hit would incorrectly use smooth scrolling.
    if (!findActive) return;
    const messageNode = Array.from(
      root?.querySelectorAll<HTMLElement>("[data-msg-id]") ?? [],
    ).find((node) => node.dataset.msgId === findActive.messageId);
    const hit = messageNode?.querySelectorAll<HTMLElement>(".find-hit")[findActive.localIndex];
    if (!hit) return;
    hit.classList.add("find-hit-active");
    const queryJustChanged = findPrevQueryRef.current !== findQuery;
    findPrevQueryRef.current = findQuery;
    hit.scrollIntoView?.({
      behavior: queryJustChanged ? "auto" : "smooth",
      block: "center",
    });
  }, [findActive, findOccurrences, findQuery]);
  const runtimeKey = runtimePanelKey(workspaceView);
  const closeWorkspace = () => transitionWorkspace(null);
  const openWorkspace = (view: WorkspaceTarget) => transitionWorkspace(workspaceViewRef.current === view ? null : view);
  return (
    <>
    {sessionId && <SessionHeader key={sessionId} sessionId={sessionId} title={title || "新任务"} cwd={cwd}
      onRename={onRename} navigation={navigation ?? { onNewTask }} leading={headerLeading}
      actions={{ ...sessionActions, onToast,
        onRewind: hasContent ? () => setHistoryAction("rewind") : undefined,
        onFork: hasContent ? () => setHistoryAction("fork") : undefined,
      }} historyDisabled={historyDisabled}
      summary={{ searchable, hasContent, changeCount: changes.totalFiles, artifactCount: artifacts.length,
        hasPlan: hasVisiblePlan, planCompleted: plan?.entries.filter(e => e.status === "completed").length ?? 0,
        planTotal: plan?.entries.length ?? 0, subagentCount,
        runningSubagents: collaboration.filter(a => a.status === "running" || a.status === "in_progress").length,
        teamCount: teams.length, status, attention: Boolean(pendingPermission || awaitingPlan || awaitingQuestion || error || failed),
      }} activeView={workspaceView} onView={openWorkspace} onCloseView={closeWorkspace}
      onFind={() => findOpen ? closeFind() : openFind()} findOpen={findOpen}
      questionHistoryTriggerRef={questionHistoryTriggerRef}
      onQuestionHistory={questions.length ? () => { closeFind(); setQuestionHistoryOpen(true); } : undefined}
    />}
    <div className={"chatview" + (panelOpen ? " chatview--with-panel" : "")}>
      <div className="chatview__main">
        {notice}
        {traceLoadError && <div className="chatview__error-banner" role="alert">
          <span>{traceLoadError}</span>
          <button type="button" onClick={() => { if (sessionId) void hydrateKnowledgeTraces(sessionId).then(() => useKnowledgeStore.getState().setTraceLoadError(sessionId)).catch(error => onToast?.(`恢复来源失败：${friendlyError(error)}`)); }}>重试恢复知识来源</button>
        </div>}
        {error && (
          <div className="chatview__error-banner" role="alert">
            <span className="chatview__error-text" style={{ whiteSpace: "pre-wrap" }}>
              {formatAgentError(error) ?? error}
            </span>
            <button
              className="chatview__error-close"
              onClick={() => useSessionStore.getState().setError(null)}
              aria-label="关闭错误提示"
            >
              ×
            </button>
          </div>
        )}
        {questionHistoryOpen && <QuestionHistoryPopover items={questions} triggerRef={questionHistoryTriggerRef}
          onSelect={jumpToQuestion} onClose={closeQuestionHistory} onFind={openFind} />}
        <FindBar
          occurrences={findOccurrences}
          open={findOpen}
          query={findQuery}
          onQueryChange={(next) => {
            setFindQuery(next);
            // Prevent the previous query's occurrence from being applied to
            // the new set of marks before FindBar publishes its first hit.
            setFindActive(null);
          }}
          onClose={closeFind}
          onActiveChange={setFindActive}
        />

        <div className="chatview__scroll-shell">
          <div className="chatview__scroll" ref={scrollRef}>
            <div className="chatview__inner" ref={contentRef}>
              {runtimeKey && <section className="chatview__runtime-view" aria-label="任务工作视图">
                <div data-runtime-panel-anchor={runtimeKey} />
                <div className="chatview__runtime-heading"><strong>{planOpen ? "执行计划" : fileChangesOpen ? "文件变更" : subagentsOpen ? "协作详情" : "任务团队"}</strong><button type="button" className="main-topbar__btn" aria-label="关闭工作视图" onClick={closeWorkspace}>×</button></div>
              {hasVisiblePlan && planOpen && <>
                <PlanPanel sessionId={sessionId ?? undefined} onSend={onSend} onToast={onToast} />
              </>}
              {fileChangesOpen && (
                <><FileChangesPanel messages={messages} /></>
              )}
              {subagentsOpen && (
                <><SubagentPanel
                  messages={messages}
                  cwd={cwd}
                  onOpenSession={onOpenSubagentSession ? openSubagentSession : undefined}
                  restorePoint={subagentScrollRestore}
                  onRestoreReady={restoreSubagentRow}
                /></>
              )}
              {teamsOpen && (
                <><TeamStatusView key={sessionId} sessionId={sessionId} messages={messages}
                  onOpenGroup={onOpenTeamGroup}
                  onUseTeam={(teamId) => {
                    if (!sessionId) return;
                    const next = draft.trim()
                      ? `${draft}\n\n请使用团队“${teamId}”，按成员职责分工完成以上任务。`
                      : `请使用团队“${teamId}”，按成员职责分工完成以下任务：\n`;
                    setResendText(next);
                    setResendAttachments(undefined);
                    setResendNonce((nonce) => nonce + 1);
                    onToast?.("已填入团队指令，请补充任务后发送");
                  }}
                  onViewTasks={() => {
                    transitionWorkspace("subagents");
                  }}
                /></>
              )}
              </section>}
              {timeline.map((node) => {
                // 时间线分隔符(对齐 EchoAgent message-timeline):日期/模型切换分隔。
                // 当前 ChatMessage 无 modelId/createdAt,无分隔符时仅渲染消息节点。
                if (node.kind === "date-divider") {
                  return (
                    <div key={node.key} className="timeline-divider timeline-divider--date">
                      {node.label}
                    </div>
                  );
                }
                if (node.kind === "model-divider") {
                  return (
                    <div key={node.key} className="timeline-divider timeline-divider--model">
                      {node.label}
                    </div>
                  );
                }
                const m = node.message;
                const idx = node.index;
                // 重试只对最后一条 assistant 消息开放（重试中间消息没有语义）。
                const isLastAssistant =
                  m.role === "assistant" && idx === messages.length - 1;
                // 会话内查找:命中容器高亮(当前命中更深一层)。
                const findCls = findOpen && isFindHit(findHitIds, m.id)
                  ? m.id === findActive?.messageId
                    ? " msg-wrap--find-current"
                    : " msg-wrap--find-hit"
                  : "";
                return (
                  <div key={`${sessionId}:${m.id}`} className={"msg-wrap" + findCls + (m.id === jumpTargetId ? " msg-wrap--jump-target" : "")} data-msg-id={m.id} tabIndex={-1}>
                    <MessageItem
                      message={m}
                      streaming={streaming && m.id === streamingMessageId}
                      markdownConfig={markdownConfig}
                      cwd={cwd}
                      sessionId={sessionId ?? undefined}
                      onToast={onToast}
                      onOpenTool={handleOpenTool}
                      findQuery={findOpen ? findQuery : undefined}
                      onEditResend={handleEditResend}
                      autoExpandProcess={false}
                      latest={isLastAssistant}
                      retrying={isLastAssistant && retryingSessionId === sessionId}
                      onRetry={
                        isLastAssistant && !streaming && m.complete
                          ? handleRetry
                          : undefined
                      }
                    />
                  </div>
                );
              })}
            </div>
          </div>
          {!following && messages.length > 0 && (
            <button
              type="button"
              className="chatview__jump-latest"
              onClick={scrollToBottom}
              aria-label="回到最新消息并恢复自动跟随"
              title="回到最新消息并恢复自动跟随"
            >
              <span aria-hidden="true">↓</span>
              回到最新
            </button>
          )}
        </div>
        <div className="chatview__footer">
          <AutomationControls sessionId={sessionId} streaming={streaming} onToast={onToast}
            onContinue={() => onSend("继续")} onPause={() => onCancel("pause")} placement="toolbar" />
          {/* Inline permission / question cards: session-scoped, never block sidebar. */}
          <AutomationControls
            sessionId={sessionId}
            streaming={streaming}
            onToast={onToast}
            placement="approval"
          />
          <PermissionInlineCard sessionId={sessionId} />
          {awaitingPlan && <div className="yield-banner" role="status"><span>执行计划等待确认</span><button type="button" className="btn btn--ghost" onClick={() => { if (!planOpen) openWorkspace("plan"); }}>查看并确认计划</button></div>}
          <QuestionInlineCard sessionId={sessionId} />
          {control && automationMode === "default" && (
            <div className="yield-banner" role="status">
              <span>
                {control.phase === "pausing" && "正在暂停任务…"}
                {control.phase === "paused" && "任务已暂停，发送“继续”即可续做"}
                {control.phase === "stopping" && "正在停止任务…"}
                {control.phase === "stopped" && stoppedTaskLabel(stoppedCategory)}
              </span>

            </div>
          )}
          {/* 流式时提供「暂停」按钮(软停止,区别于停止按钮的硬取消)。 */}
          {sessionId && streaming && !control && automationMode === "default" && (
            <button
              type="button"
              className="chatview__pause-btn"
              onClick={handlePause}
              title="暂停生成(保留会话,可继续)"
            >
              <PauseIcon size="sm" style={{ verticalAlign: "text-bottom" }} /> 暂停
            </button>
          )}
          {/* 消息队列(对齐 EchoAgent message-queue):流式时可继续排队 prompt。
              非流式时面板为空(QueuePanel 内部 queue.length===0 直接 return null)。 */}
          {sessionId && (
            <QueuePanel
              sessionId={sessionId}
              streaming={streaming}
              sendNowPending={sendNowPending}
              awaitingQuestion={awaitingQuestion}
              onSendNow={streaming ? onSendNow : onSend}
            />
          )}
          <Composer
            streaming={streaming}
            disabled={control?.phase === "pausing" || control?.phase === "stopping"}
            apiReady={apiReady}
            setupHint={setupHint}
            onOpenSettings={onOpenSettings}
            onSend={onSend}
            onSendNow={onSendNow}
            sendNowPending={sendNowPending}
            awaitingQuestion={awaitingQuestion}
            onEnqueue={
              sessionId
                ? (text, attachments) => {
                    useMessageQueueStore.getState().enqueue(sessionId, text, attachments);
                    onToast?.("已加入待发送队列");
                  }
                : undefined
            }
            onCancel={() => onCancel("stop")}
            onControl={handleTextControl}
            cancelling={cancelling}
            modelId={modelId}
              modelLoading={modelLoading}
            models={models}
            onModelChange={onModelChange}
            cwd={cwd}
            showDisclaimer
            permissionInline
            onToast={onToast}
            draft={draft}
            draftKey={sessionId ?? undefined}
            onDraftChange={
              sessionId ? (t) => setDraft(sessionId, t) : undefined
            }
            externalText={resendText}
            externalAttachments={resendAttachments}
            externalTextNonce={resendNonce}
            onSelectExpert={onSelectExpert}
            onNavigateConnectors={onNavigateConnectors}
            automationMode={automationMode}
            automationModeDisabled={automationModeChanging}
            onAutomationModeChange={handleAutomationModeChange}
            knowledgeSessionId={sessionId ?? undefined}
            onOpenKnowledgeBase={onOpenKnowledgeBase}
            onOpenMeetingMinutes={onOpenMeetingMinutes}
            onOpenOrganization={onOpenOrganization}
            commandSessionId={sessionId ?? undefined}
            commandRefreshKey={commandRefreshKey}
            onClientSlashCommand={onClientSlashCommand}
            activeExpertName={activeExpertName}
            activeExpertAvatar={activeExpertAvatar}
            usageSessionId={sessionId ?? undefined}
            usageMsgCount={messages.length}
            filePaths={mentionCandidates.filePaths}
            workspaceSymbols={mentionCandidates.workspaceSymbols}
          />
        </div>
      </div>

      <ToolSidePanel
        open={panelOpen}
        mode={panelMode}
        toolCall={activeTool}
        artifacts={artifacts}
        previewPath={previewPath}
        cwd={cwd}
        messages={messages}
        sessionId={sessionId ?? undefined}
        onToast={onToast}
        onClose={closeWorkspace}
        onModeChange={transitionWorkspace}
        onSelectTool={handleOpenTool}
        onSelectArtifact={handleSelectArtifact}
        onOpenArtifacts={handleOpenArtifacts}
        findToolCall={(id) => findToolCall(messages, id)}
      />
      {retryDialog}
      {sessionId && historyAction && !historyDisabled && <RewindBar key={sessionId} sessionId={sessionId} cwd={cwd}
        canExecute={canExecuteHistory}
        action={historyAction} onActionDone={() => { if (useSessionStore.getState().sessionId === sessionId) setHistoryAction(null); }} onRewound={onRewound}
        onForked={onForked} onToast={onToast} />}
    </div>
    </>
  );
}
