import { useSessionWorkspace } from "@/lib/use-session-workspace";
import { SessionWorkspaceDirectory, SessionWorkspaceWarning } from "./SessionWorkspace";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback, type ReactNode } from "react";
import { Play } from "lucide-react";
import { TasksPanel } from "./TasksPanel";
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
import { artifactFileKey } from "@/lib/artifact-file-key";
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
import { ConversationNavigator } from "./ConversationNavigator";
import { buildConversationTurns } from "@/lib/conversation-navigation";
import { FileChangesPanel } from "./FileChangesPanel";
import { SubagentPanel, mergePanelItems } from "./SubagentPanel";
import { TeamStatusView } from "./TeamStatusView";
import { SessionHeader, type SessionNavigationProps, type WorkspaceTarget } from "./SessionHeader";
import { aggregateFileChanges } from "@/lib/file-changes";
import { isExecutionSettled, summarizeExecutionProcess } from "@/lib/execution-process";
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

type WorkspaceView = WorkspaceTarget | "tool";

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
  onReloadWorkspace,
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
  navigation,
  headerLeading,
  notice,
  taskRefreshSignal,
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
  onReloadWorkspace?: (cwd: string) => Promise<void>;
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
  navigation?: SessionNavigationProps;
  headerLeading?: ReactNode;
  notice?: ReactNode;
  taskRefreshSignal?: number;
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
  const workspaceRefreshSignal = useMemo(() => ({error, revision:taskRefreshSignal}), [error, taskRefreshSignal]);
  const workspace = useSessionWorkspace(sessionId, cwd, workspaceRefreshSignal, onReloadWorkspace, onToast);
  const hasVisiblePlan = Boolean(plan && (plan.entries.length > 0 || planRevisionDirty) || planApproval?.sessionId === sessionId && planApproval);
  const traceLoadError = useKnowledgeStore(state => sessionId ? state.traceLoadErrors[sessionId] : undefined);
  const agentMode = useSessionStore((s) => s.agentMode);
  const control = useSessionStore((s) => s.control);
  const awaitingQuestion = Boolean(useQuestionStore(selectQuestionForSession(sessionId)));
  const pendingPermission = usePermissionStore(selectPermissionForSession(sessionId));
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
  const conversationTurns = useMemo(() => buildConversationTurns(messages, questions), [messages, questions]);
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
  const sessionWorkspaceViews = useRef(new Map<string, WorkspaceView | null>()).current;
  const detailsRef = useRef<HTMLDivElement>(null);
  const lastWorkspaceViews = useRef(new Map<string, WorkspaceView>()).current;
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView | null>(() => sessionId ? sessionWorkspaceViews.get(sessionId) ?? null : null);
  // A tab activation changes both the view and selection in one React batch.
  // Selection callbacks must see the view selected earlier in that batch.
  const workspaceViewRef = useRef(workspaceView);
  workspaceViewRef.current = workspaceView;
  const subagentsOpen = workspaceView === "subagents";
  const teamsOpen = workspaceView === "teams";
  const planOpen = workspaceView === "plan";
  const visitedRuntime = useRef<{session: string | null; views: Set<RuntimePanelKey>}>({session: sessionId, views: new Set()});
  if (visitedRuntime.current.session !== sessionId) visitedRuntime.current = {session: sessionId, views: new Set()};
  const currentRuntime = runtimePanelKey(workspaceView);
  if (currentRuntime) visitedRuntime.current.views.add(currentRuntime);
  const [historyAction, setHistoryAction] = useState<"rewind" | "fork" | null>(null);
  const historyDisabled = !workspace.available || workspace.busy || modelLoading || historyIsBusy({ streaming, sendNowPending, control });
  const modelLoadingRef = useRef(modelLoading);
  modelLoadingRef.current = modelLoading;
  // Invalidate the workflow, rather than reopening its old confirmation when
  // the next turn finishes. RewindBar also checks the live store before IPC.
  useLayoutEffect(() => {
    if (historyDisabled) setHistoryAction(null);
  }, [historyDisabled]);
  const canExecuteHistory = useCallback(() => {
    const current = useSessionStore.getState();
    return workspace.available && !workspace.busy && current.sessionId === sessionId && !modelLoadingRef.current && !historyIsBusy(current);
  }, [sessionId, workspace.available, workspace.busy]);
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
  const continuingRef = useRef(new Set<string>());
  const [continuingSessions, setContinuingSessions] = useState(new Set<string>());
  const continuing = !!sessionId && continuingSessions.has(sessionId);
  const activeSessionRef = useRef(sessionId);
  activeSessionRef.current = sessionId;
  const continueTask = async () => {
    if (!sessionId || !workspace.available || workspace.busy || continuingRef.current.has(sessionId) || automationMode !== "default" || !apiReady || modelLoading || awaitingQuestion || pendingPermission || awaitingPlan) return;
    continuingRef.current.add(sessionId);
    setContinuingSessions(new Set(continuingRef.current));
    try {
      const accepted = await onSend("继续", []);
      if (accepted === false && activeSessionRef.current === sessionId) onToast?.("暂时无法继续，请检查当前任务状态后重试");
    } catch (cause) { if (activeSessionRef.current === sessionId) onToast?.(`继续失败：${friendlyError(cause)}`); }
    finally { continuingRef.current.delete(sessionId); setContinuingSessions(new Set(continuingRef.current)); }
  };
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
  const { requestConfirmation, dismiss: dismissRetry, dialog: retryDialog } = useAppDialog(sessionId);
  const retryBlocked = historyDisabled || Boolean(pendingPermission || awaitingQuestion || planApproval?.sessionId === sessionId);
  const retryBlockedRef = useRef(retryBlocked);
  retryBlockedRef.current = retryBlocked;
  useEffect(() => { if (retryBlocked) dismissRetry(); }, [retryBlocked, dismissRetry]);
  const performRetry = useCallback(async (kind: MessageRetryKind) => {
    if (!sessionId || streaming || retryBlockedRef.current || retryingSessionsRef.current.has(sessionId)) return;
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
      const checkRetryState = () => {
        const current = useSessionStore.getState();
        const transcript = current.transcripts?.[targetSessionId];
        if (current.sessionId === targetSessionId && retryBlockedRef.current
          || transcript?.streamingMessageId || transcript?.pendingSendNowPromptId
          || transcript?.control?.phase === "pausing" || transcript?.control?.phase === "stopping") {
          throw new Error("任务状态已变化，请稍后重试；原回复已保留");
        }
      };
      checkRetryState();

      // Rewind the conversation to the last user prompt (conversation only —
      // don't touch files), which drops the assistant turn we're regenerating.
      const points = await rewindPoints(targetSessionId);
      checkRetryState();
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
  const panelOpen = workspaceView !== null;
  const panelMode: ToolSidePanelMode = panelOpen ? workspaceView as ToolSidePanelMode : "artifacts";
  const [activeTool, setActiveTool] = useState<ToolCallView | null>(null);
  const [previewRequest, setPreviewRequest] = useState<{ path: string; artifact?: SessionArtifact; sessionId: string | null; sequence: number } | null>(null);
  const workspaceSelectionRef = useRef({tool: activeTool, preview: previewRequest});
  workspaceSelectionRef.current = {tool: activeTool, preview: previewRequest};
  const previewSequence = useRef(0);
  const [workspaceNavigationId, setWorkspaceNavigationId] = useState(0);
  const previewPath = previewRequest?.sessionId === sessionId ? previewRequest?.path ?? null : null;

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
    const registered = exportArtifacts?.sessionId === sessionId ? exportArtifacts.items : [];
    const justExported = previewRequest?.sessionId === sessionId && previewRequest.artifact?.verifiedOutput ? [previewRequest.artifact] : [];
    return collectSessionArtifacts(messages, cwd, [...registered, ...justExported]);
  }, [messages, exportArtifacts, sessionId, cwd, previewRequest]);

  const artifactCatalogRef = useRef(artifacts);
  artifactCatalogRef.current = artifacts;

  // Restore only the selected session's view; tool and preview payloads never cross sessions.
  useLayoutEffect(() => {
    const restored = sessionId ? sessionWorkspaceViews.get(sessionId) ?? null : null;
    workspaceViewRef.current = restored;
    setWorkspaceView(restored);
    setHistoryAction(null);
    setActiveTool(null);
    setPreviewRequest(null);
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
  const collaboration = useMemo(() => mergePanelItems(liveSubagents, derivedSubagents), [liveSubagents, derivedSubagents]);
  const subagentCount = collaboration.length;
  const searchable = messages.some(m => m.parts.some(p => p.kind === "text" && p.text.trim()));
  const hasContent = messages.some(m => m.parts.length > 0 || m.attachments?.length);
  const awaitingPlan = planApproval?.sessionId === sessionId;
  const terminalOutcome = useMemo(() => !streaming && terminalMessage?.complete
    ? summarizeExecutionProcess(terminalMessage.parts,false,terminalMessage.stopReason,
      terminalMessage.cancellationCategory,terminalMessage.cancelTrigger,{settled:isExecutionSettled(terminalMessage)})
    : undefined,[streaming,terminalMessage]);
  const failed = terminalOutcome?.state === "failed";
  const incomplete = terminalOutcome?.state === "partial" || terminalOutcome?.state === "attention";
  const status = pendingPermission ? "等待审批" : awaitingPlan ? "等待计划确认" : awaitingQuestion ? "等待回答"
    : control?.phase === "pausing" ? "正在暂停" : control?.phase === "paused" ? "已暂停"
    : control?.phase === "stopping" ? "正在停止" : control?.phase === "stopped" ? "已停止"
    : error || failed ? "任务出错" : streaming ? "进行中"
    : terminalOutcome?.state === "partial" ? "部分完成" : incomplete ? "待核实" : undefined;

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
  const transitionWorkspace = useCallback((next: WorkspaceView | null) => {
    closeQuestionHistory();
    if (workspaceViewRef.current === next) return;
    workspaceViewRef.current = next;
    if (sessionId) {
      sessionWorkspaceViews.set(sessionId, next === "tool" ? "artifacts" : next);
      if (next) lastWorkspaceViews.set(sessionId, next);
      if (lastWorkspaceViews.size > 50) lastWorkspaceViews.delete(lastWorkspaceViews.keys().next().value!);
      if (sessionWorkspaceViews.size > 50) sessionWorkspaceViews.delete(sessionWorkspaceViews.keys().next().value!);
    }
    setWorkspaceView(next);
  }, [closeQuestionHistory, sessionId]);

  type WorkspaceFrame = { view: WorkspaceView; tool: ToolCallView | null; path?: string; artifact?: SessionArtifact };
  const workspaceTrail = useRef<WorkspaceFrame[]>([]);
  const [workspaceTrailDepth, setWorkspaceTrailDepth] = useState(0);
  useLayoutEffect(() => { workspaceTrail.current = []; setWorkspaceTrailDepth(0); }, [sessionId]);
  const pushWorkspaceFrame = useCallback(() => {
    const selection = workspaceSelectionRef.current;
    workspaceTrail.current.push({ view: workspaceViewRef.current ?? "artifacts", tool: selection.tool,
      path: selection.preview?.sessionId === sessionId ? selection.preview.path : undefined,
      artifact: selection.preview?.sessionId === sessionId ? selection.preview.artifact : undefined });
    if (workspaceTrail.current.length > 20) workspaceTrail.current.shift();
    setWorkspaceTrailDepth(workspaceTrail.current.length);
  }, [sessionId]);
  const handleOpenTool = useCallback((tc: ToolCallView) => {
    if (workspaceViewRef.current !== "tool" || workspaceSelectionRef.current.tool?.toolCallId !== tc.toolCallId) pushWorkspaceFrame();
    setActiveTool(tc);
    setPreviewRequest(null);
    transitionWorkspace("tool");
  }, [pushWorkspaceFrame, transitionWorkspace]);
  const handleSelectArtifact = useCallback((artifact: SessionArtifact) => {
    const current = workspaceViewRef.current;
    if (current === "tool") pushWorkspaceFrame();
    setPreviewRequest({ path: artifact.path, artifact, sessionId, sequence: ++previewSequence.current });
    const catalogued = artifact.verifiedOutput || artifactCatalogRef.current.some(item => artifactFileKey(item.path, cwd) === artifactFileKey(artifact.path, cwd));
    transitionWorkspace(current === "fileTree" ? "fileTree" : catalogued ? "artifacts" : "fileTree");
  }, [cwd, pushWorkspaceFrame, sessionId, transitionWorkspace]);
  const handleWorkspaceBack = () => {
    const previous = workspaceTrail.current.pop();
    setWorkspaceTrailDepth(workspaceTrail.current.length);
    if (!previous) return;
    setActiveTool(previous.tool);
    setPreviewRequest(previous.path ? { path: previous.path, artifact: previous.artifact, sessionId, sequence: ++previewSequence.current } : null);
    transitionWorkspace(previous.view);
  };
  const handleWorkspaceCategory = (next: ToolSidePanelMode) => {
    workspaceTrail.current = [];
    setWorkspaceTrailDepth(0);
    transitionWorkspace(next);
  };
  // A rewind can remove the inspected operation; stale tool payloads must not survive it.
  useEffect(() => {
    if (!activeTool) return;
    const fresh = findToolCall(messages, activeTool.toolCallId);
    if (fresh) {
      if (fresh !== activeTool) setActiveTool(fresh);
    } else {
      setActiveTool(null);
      workspaceTrail.current = [];
      setWorkspaceTrailDepth(0);
      if (workspaceViewRef.current === "tool") transitionWorkspace("artifacts");
    }
  }, [messages, activeTool, transitionWorkspace]);
  const handleOpenArtifacts = useCallback(() => {
    setWorkspaceNavigationId(value => value + 1);
    transitionWorkspace("artifacts");
  }, [transitionWorkspace]);

  const jumpToQuestion = useCallback((messageId: string) => {
    const row = Array.from(scrollRef.current?.querySelectorAll<HTMLElement>("[data-msg-id]") ?? [])
      .find((node) => node.dataset.msgId === messageId);
    closeQuestionHistory();
    if (!row) return;
    pauseFollowing();
    if (jumpHighlightTimerRef.current !== null) window.clearTimeout(jumpHighlightTimerRef.current);
    setJumpTargetId(messageId);
    row.focus({ preventScroll: true });
    row.scrollIntoView?.({ behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" });
    jumpHighlightTimerRef.current = window.setTimeout(() => {
      setJumpTargetId(null);
      jumpHighlightTimerRef.current = null;
    }, 2200);
  }, [closeQuestionHistory, pauseFollowing, scrollRef]);

  const restoredSequenceRef = useRef<number | null>(null);
  const restoreFrameRef = useRef<number | null>(null);
  const restoreSubagentRow = useCallback((key: string) => {
    if (workspaceView !== "subagents" || !subagentScrollRestore || subagentScrollRestore.parentSessionId !== sessionId
      || restoredSequenceRef.current === subagentScrollRestore.sequence) return;
    if (restoreFrameRef.current !== null) window.cancelAnimationFrame(restoreFrameRef.current);
    // Child rows mount before the workspace restores its own scroll cache.
    // Apply the exact parent-row position after both layout passes have settled.
    restoreFrameRef.current = window.requestAnimationFrame(() => {
      restoreFrameRef.current = null;
      if (activeSessionRef.current !== sessionId || workspaceViewRef.current !== "subagents") return;
      const viewport = detailsRef.current;
      const row = Array.from(viewport?.querySelectorAll<HTMLElement>("[data-subagent-key]") ?? [])
        .find(node => node.dataset.subagentKey === key);
      if (!viewport || !row) return;
      viewport.scrollTop = subagentScrollRestore.scrollTop;
      const actualOffset = row.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
      viewport.scrollTop += actualOffset - subagentScrollRestore.rowOffset;
      restoredSequenceRef.current = subagentScrollRestore.sequence;
    });
  }, [sessionId, subagentScrollRestore, workspaceView]);
  useEffect(() => () => {
    if (restoreFrameRef.current !== null) window.cancelAnimationFrame(restoreFrameRef.current);
  }, []);
  useLayoutEffect(() => {
    if (subagentScrollRestore) restoreSubagentRow(subagentScrollRestore.subagentKey);
  }, [messages, restoreSubagentRow, subagentScrollRestore]);

  const openSubagentSession = useCallback((childSessionId: string, childCwd: string | undefined, subagentKey: string) => {
    if (!sessionId || !onOpenSubagentSession) return;
    const viewport = detailsRef.current;
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
  }, [cwd, onOpenSubagentSession, sessionId]);

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
  const closeWorkspace = () => transitionWorkspace(null);
  const openWorkspace = (view: WorkspaceTarget) => {
    setWorkspaceNavigationId(value => value + 1);
    transitionWorkspace(workspaceViewRef.current === view ? null : view);
  };
  return (
    <>
    {sessionId && <SessionHeader key={sessionId} sessionId={sessionId} title={title || "新任务"}
      onRename={onRename} navigation={navigation ?? { onNewTask }} leading={headerLeading}
      actions={{ onToast,
        onRewind: hasContent ? () => setHistoryAction("rewind") : undefined,
        onFork: hasContent ? () => setHistoryAction("fork") : undefined,
      }} historyDisabled={historyDisabled}
      summary={{ searchable, hasContent, changeCount: changes.totalFiles, artifactCount: artifacts.length,
        hasPlan: hasVisiblePlan, planCompleted: plan?.entries.filter(e => e.status === "completed").length ?? 0,
        planTotal: plan?.entries.length ?? 0, subagentCount,
        runningSubagents: collaboration.filter(a => a.status === "running" || a.status === "in_progress").length,
        teamCount: teams.length, status, attention: Boolean(pendingPermission || awaitingPlan || awaitingQuestion || error || failed || incomplete),
      }} activeView={workspaceView} onView={openWorkspace} onCloseView={closeWorkspace}
      onToggleWorkspace={() => {
        const last = sessionId ? lastWorkspaceViews.get(sessionId) : undefined;
        transitionWorkspace(workspaceViewRef.current ? null : last === "tool" && !activeTool ? "artifacts" : last ?? "artifacts");
      }}
      onFind={() => findOpen ? closeFind() : openFind()} findOpen={findOpen}
    />}
    <div className={"chatview" + (panelOpen ? " chatview--with-panel" : "")}>
      <div className="chatview__main">
        {notice}
        {!modelLoading && <SessionWorkspaceWarning workspace={workspace} onNewTask={onNewTask} />}
        {traceLoadError && <div className="chatview__error-banner" role="alert">
          <span>{traceLoadError}</span>
          <button type="button" onClick={() => { if (sessionId) void hydrateKnowledgeTraces(sessionId).then(() => useKnowledgeStore.getState().setTraceLoadError(sessionId)).catch(error => onToast?.(`恢复来源失败：${friendlyError(error)}`)); }}>重试恢复知识来源</button>
        </div>}
        {error && error !== workspace.value?.message && (
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
          <ConversationNavigator key={sessionId} turns={conversationTurns} scrollRef={scrollRef} contentRef={contentRef}
            onSelect={jumpToQuestion} onDirectory={trigger => { questionHistoryTriggerRef.current = trigger; closeFind(); setQuestionHistoryOpen(true); }} />
          <div className="chatview__scroll" ref={scrollRef}>
            <div className="chatview__inner" ref={contentRef}>
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
                      waitingForModel={!pendingPermission && !awaitingPlan && !awaitingQuestion && !control && !error}
                      markdownConfig={markdownConfig}
                      cwd={cwd}
                      sessionId={sessionId ?? undefined}
                      onToast={onToast}
                      onOpenTool={handleOpenTool}
                      onOpenArtifact={handleSelectArtifact}
                      findQuery={findOpen ? findQuery : undefined}
                      onEditResend={handleEditResend}
                      autoExpandProcess={false}
                      compactIdentity={m.role === "assistant" && messages[idx - 1]?.role === "assistant"}
                      latest={isLastAssistant}
                      retrying={isLastAssistant && retryingSessionId === sessionId}
                      retryDisabled={retryBlocked}
                      retryDisabledReason={!workspace.available || workspace.busy ? "请先恢复本任务的工作目录，再重试回复" : undefined}
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
            continueDisabled={!workspace.available || workspace.busy || modelLoading}
            onContinue={() => workspace.available && !workspace.busy ? onSend("继续") : false} onPause={() => onCancel("pause")} placement="toolbar" />
          <div className="session-task-controls"><TasksPanel sessionId={sessionId ?? undefined} refreshSignal={taskRefreshSignal} onToast={onToast} presentation="summary" onOpen={() => transitionWorkspace("subagents")} /></div>
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
                {control.phase === "paused" && "任务已暂停，可继续执行"}
                {control.phase === "stopping" && "正在停止任务…"}
                {control.phase === "stopped" && stoppedTaskLabel(stoppedCategory)}
              </span>
              {control.phase === "paused" && <button type="button" className="btn btn--primary" disabled={continuing || !workspace.available || workspace.busy || !apiReady || modelLoading || awaitingQuestion || Boolean(pendingPermission) || awaitingPlan} onClick={() => void continueTask()}><Play size={14} />{continuing ? "正在继续…" : "继续任务"}</button>}
            </div>
          )}
          {/* 消息队列(对齐 EchoAgent message-queue):流式时可继续排队 prompt。
              非流式时面板为空(QueuePanel 内部 queue.length===0 直接 return null)。 */}
          {sessionId && (
            <QueuePanel
              sessionId={sessionId}
              streaming={streaming}
              sendNowPending={sendNowPending}
              awaitingQuestion={awaitingQuestion || Boolean(pendingPermission) || awaitingPlan || control?.phase === "pausing" || control?.phase === "stopping"}
              onSendNow={streaming ? onSendNow : onSend}
            />
          )}
          <Composer
            streaming={streaming}
            sendDisabled={!workspace.available || workspace.busy}
            disabled={control?.phase === "pausing" || control?.phase === "stopping"}
            apiReady={apiReady}
            setupHint={setupHint}
            onOpenSettings={onOpenSettings}
            onSend={onSend}
            onSendNow={onSendNow}
            sendNowPending={sendNowPending}
            awaitingQuestion={awaitingQuestion || Boolean(pendingPermission) || awaitingPlan}
            onEnqueue={
              sessionId
                ? (text, attachments) => {
                    useMessageQueueStore.getState().enqueue(sessionId, text, attachments);
                    onToast?.("已加入待发送队列");
                  }
                : undefined
            }
            onCancel={() => onCancel("stop")}
            onPause={() => onCancel("pause")}
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
          />
        </div>
      </div>

      <ToolSidePanel key={sessionId}
        detailsRef={detailsRef}
        details={<section className="chatview__runtime-view" aria-label="任务工作视图">

              <section hidden={!planOpen}>
              {visitedRuntime.current.views.has("plan") && (hasVisiblePlan
                ? <PlanPanel sessionId={sessionId ?? undefined} onSend={onSend} onToast={onToast} />
                : <p className="tool-side-panel__empty">当前任务暂无执行计划。</p>)}
              </section>
              <section hidden={workspaceView !== "changes"}>
              {visitedRuntime.current.views.has("changes") && (
                <><FileChangesPanel messages={messages} /></>
              )}
              </section>
              <section hidden={!subagentsOpen}>
              {visitedRuntime.current.views.has("subagents") && (
                <><TasksPanel sessionId={sessionId ?? undefined} refreshSignal={taskRefreshSignal} onToast={onToast} /><SubagentPanel
                  messages={messages}
                  cwd={cwd}
                  onOpenSession={onOpenSubagentSession ? openSubagentSession : undefined}
                  restorePoint={subagentScrollRestore}
                  onRestoreReady={restoreSubagentRow}
                /></>
              )}
              </section>
              <section hidden={!teamsOpen}>
              {visitedRuntime.current.views.has("teams") && (
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
              </section>
              </section>}
        open={panelOpen}
        mode={panelMode}
        toolCall={activeTool}
        artifacts={artifacts}
        previewPath={previewPath}
        previewRequestId={previewRequest?.sequence}
        navigationRequestId={workspaceNavigationId}
        workspaceInfo={<SessionWorkspaceDirectory workspace={workspace} onToast={onToast} />}
        workspaceAvailable={workspace.available}
        cwd={cwd}
        messages={messages}
        sessionId={sessionId ?? undefined}
        onToast={onToast}
        onClose={closeWorkspace}
        onModeChange={handleWorkspaceCategory}
        onBack={workspaceTrailDepth ? handleWorkspaceBack : undefined}
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
