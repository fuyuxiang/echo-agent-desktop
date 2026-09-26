import { useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback } from "react";
import { PauseIcon } from "@/foundation/components/Icon/icons";
import { useSessionStore, type ToolCallView } from "@/stores/session-store";
import { useSessionsStore } from "@/stores/sessions-store";
import { createMarkdownHostConfig } from "@/lib/markdown-host";
import { rewindExecute, rewindPoints, setCodingMode } from "@/lib/agent-client";
import {
  collectSessionArtifacts,
  findToolCall,
  type SessionArtifact,
} from "@/lib/session-artifacts";
import { MessageItem } from "./MessageItem";
import { Composer } from "./Composer";
import { PlanPanel } from "./PlanPanel";
import { RewindBar } from "./RewindBar";
import { PermissionInlineCard } from "./PermissionDialog";
import { QuestionInlineCard } from "./QuestionInlineCard";
import { ToolSidePanel, type ToolSidePanelMode } from "./ToolSidePanel";
import { FindBar, isFindHit, type FindOccurrence } from "./FindBar";
import { FileChangesPanel } from "./FileChangesPanel";
import { SubagentPanel } from "./SubagentPanel";
import { TeamStatusView } from "./TeamStatusView";
import { ShareMenu } from "./ShareMenu";
import { QueuePanel } from "./QueuePanel";
import { WorkspacePicker } from "./WorkspacePicker";
import { useMessageQueueStore } from "@/stores/message-queue-store";
import { selectQuestionForSession, useQuestionStore } from "@/stores/question-store";
import { buildTimeline } from "@/lib/timeline-utils";
import { formatAgentError, friendlyError } from "@/lib/error-format";
import { useSubagentStore } from "@/stores/subagent-store";
import type { SessionControlAction } from "@/lib/session-control";
import type { ModelOption } from "./ModelSelector";
import type { AgentEntry } from "@/lib/types";
import type { WorkspaceInfo } from "@/lib/agent-client";
import type { SlashCommandInvocation } from "@/lib/slash-commands";
import { useWorkspaceMentions } from "@/lib/use-workspace-mentions";
import { useStickToBottom } from "./use-stick-to-bottom";
import { isGlobalShortcutBlocked } from "@/lib/keyboard-scope";
import { stripAttachmentTransportContext } from "@/lib/user-message";
import { AutomationControls } from "./AutomationControls";
import type { AutomationMode } from "@/lib/automation-client";
import { useAppDialog } from "./AppDialog";
import type {
  MessageRetryKind,
  MessageRetrySendRequest,
} from "@/lib/message-retry";
import type { SubagentOpenContext, SubagentScrollRestore } from "@/lib/subagent-navigation";

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
  newSessionTargetCwd,
  workspaces,
  onSelectWorkspace,
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
  /** Target chosen for a future session; never use it for active-session IO. */
  newSessionTargetCwd?: string;
  workspaces?: WorkspaceInfo[];
  onSelectWorkspace?: (cwd: string) => void;
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
}) {
  const messages = useSessionStore((s) => s.messages);
  const streaming = useSessionStore((s) => s.streaming);
  const sendNowPending = useSessionStore((s) => s.sendNowPending);
  const streamingMessageId = useSessionStore((s) => s.streamingMessageId);
  const error = useSessionStore((s) => s.error);
  const plan = useSessionStore((s) => s.plan);
  const sessionId = useSessionStore((s) => s.sessionId);
  const agentMode = useSessionStore((s) => s.agentMode);
  const control = useSessionStore((s) => s.control);
  const resumeSession = useSessionStore((s) => s.resumeSession);
  const awaitingQuestion = Boolean(useQuestionStore(selectQuestionForSession(sessionId)));
  const mentionCandidates = useWorkspaceMentions(cwd);
  // 会话内查找(对齐 EchoAgent chat-search)。
  const timeline = useMemo(() => buildTimeline(messages), [messages]);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findOccurrences, setFindOccurrences] = useState<FindOccurrence[]>([]);
  const [findActive, setFindActive] = useState<FindOccurrence | null>(null);
  const findHitIds = useMemo(
    () => [...new Set(findOccurrences.map((occurrence) => occurrence.messageId))],
    [findOccurrences],
  );
  // 文件变更聚合面板(对齐 EchoAgent file-changes-panel)。
  const [fileChangesOpen, setFileChangesOpen] = useState(false);
  // 子代理运行时面板(对齐 EchoAgent team-runtime)。
  const [subagentsOpen, setSubagentsOpen] = useState(false);
  const [teamsOpen, setTeamsOpen] = useState(false);
  const [automationModeChanging, setAutomationModeChanging] = useState(false);
  const automationMode: AutomationMode = agentMode === "browser_use" || agentMode === "computer_use"
    ? agentMode
    : "default";
  const handleAutomationModeChange = useCallback(async (nextMode: AutomationMode) => {
    if (!sessionId || streaming || automationModeChanging || nextMode === automationMode) return;
    setAutomationModeChanging(true);
    try {
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
  }, [automationMode, automationModeChanging, onToast, sessionId, streaming]);
  const handlePause = useCallback(async () => {
    if (!sessionId || !streaming) return;
    await onCancel("pause");
  }, [sessionId, streaming, onCancel]);
  const handleResume = useCallback(() => {
    if (!sessionId) return;
    resumeSession(sessionId);
    useSessionsStore.getState().upsert({ sessionId, status: "completed" });
    onToast?.("已恢复，可继续发送消息");
  }, [sessionId, resumeSession, onToast]);
  const handleResumeAndContinue = useCallback(async () => {
    if (!sessionId) return;
    try {
      // Keep the persisted pause barrier until the new turn is admitted. The
      // send path clears it atomically with the optimistic assistant turn; the
      // explicit resume below also supports embedders whose onSend returns void.
      const accepted = await onSend("请继续。");
      if (accepted === false) {
        onToast?.("暂未能继续，任务仍保持暂停，请检查模型、额度或待回答问题");
        return;
      }
      resumeSession(sessionId);
    } catch (error) {
      onToast?.(`继续任务失败，已保持暂停：${String(error).replace(/^Error:\s*/, "")}`);
    }
  }, [sessionId, resumeSession, onSend, onToast]);
  const handleTextControl = useCallback(async (action: SessionControlAction) => {
    if (!streaming) {
      if (control?.phase === "paused") onToast?.("当前任务已暂停");
      else if (control?.phase === "stopped") onToast?.("当前任务已停止");
      else onToast?.("当前任务没有正在运行的内容");
      return true;
    }
    return onCancel(action);
  }, [control?.phase, onCancel, onToast, streaming]);
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
  const [planOpen, setPlanOpen] = useState(false);

  // ---- 消息"编辑重发":把消息文本回填到输入框 ----
  const [resendText, setResendText] = useState<string | undefined>(undefined);
  const [resendAttachments, setResendAttachments] = useState<string[]>([]);
  const [resendNonce, setResendNonce] = useState(0);
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
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelMode, setPanelMode] = useState<ToolSidePanelMode>("tool");
  const [activeTool, setActiveTool] = useState<ToolCallView | null>(null);
  const [previewPath, setPreviewPath] = useState<string | null>(null);

  const artifacts = useMemo(() => collectSessionArtifacts(messages), [messages]);

  // Keep active tool fresh when streaming updates status/content.
  useEffect(() => {
    if (!activeTool) return;
    const fresh = findToolCall(messages, activeTool.toolCallId);
    if (fresh && fresh !== activeTool) setActiveTool(fresh);
  }, [messages, activeTool]);

  // Close panel when switching sessions.
  useEffect(() => {
    setPanelOpen(false);
    setActiveTool(null);
    setPreviewPath(null);
  }, [sessionId]);

  useEffect(() => {
    setSubagentsOpen(subagentScrollRestore?.parentSessionId === sessionId);
  }, [sessionId, subagentScrollRestore?.sequence]);

  // Auto-open subagent panel when a subagent starts running.
  const liveSubagentCount = useSubagentStore((s) =>
    sessionId ? s.getForSession(sessionId).filter((a) => a.status === "running").length : 0,
  );
  useEffect(() => {
    if (liveSubagentCount > 0) setSubagentsOpen(true);
  }, [liveSubagentCount]);

  const handleOpenTool = useCallback((tc: ToolCallView) => {
    setActiveTool(tc);
    setPreviewPath(null);
    setPanelMode("tool");
    setPanelOpen(true);
  }, []);

  const handleSelectArtifact = useCallback((a: SessionArtifact) => {
    setPreviewPath(a.path);
    setPanelMode("preview");
    setPanelOpen(true);
  }, []);

  const handleOpenArtifacts = useCallback(() => {
    setPanelMode("artifacts");
    setPanelOpen(true);
  }, []);

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
          setFindOpen(true);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [messages.length]);
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
  return (
    <div className={"chatview" + (panelOpen ? " chatview--with-panel" : "")}>
      <div className="chatview__main">
        {error && (
          <div className="chatview__error-banner" role="alert">
            <span className="chatview__error-text" style={{ whiteSpace: "pre-wrap" }}>
              {formatAgentError(error) ?? error}
            </span>
            <button
              className="chatview__error-close"
              onClick={() => useSessionStore.getState().setError(null)}
              aria-label="dismiss"
            >
              ×
            </button>
          </div>
        )}
        {/* Context and session tools share one responsive utility bar. */}
        <div className="chatview__utility-bar">
          <div className="chatview__utility-context">
            <AutomationControls
              sessionId={sessionId}
              streaming={streaming}
              onToast={onToast}
              placement="toolbar"
            />
            {cwd && workspaces && onSelectWorkspace && (
              <div className="chatview__workspace-bar">
                <WorkspacePicker
                  cwd={newSessionTargetCwd ?? cwd}
                  workspaces={workspaces}
                  onSelectWorkspace={onSelectWorkspace}
                  menuPlacement="bottom"
                />
              </div>
            )}
          </div>
          <div className="chatview__utility-actions">
            {plan && plan.entries.length > 0 && (
            <button
              className={`chatview__plan-toggle ${planOpen ? "chatview__plan-toggle--active" : ""}`}
              onClick={() => setPlanOpen((v) => !v)}
              title="执行计划"
            >
              计划 {plan.entries.filter((e) => e.status === "completed").length}/
              {plan.entries.length}
            </button>
            )}

            {artifacts.length > 0 && (
              <button
                type="button"
                className={
                  "chatview__artifacts-toggle" +
                  (panelOpen && panelMode === "artifacts"
                    ? " chatview__artifacts-toggle--active"
                    : "")
                }
                onClick={() => {
                  if (panelOpen && panelMode === "artifacts") {
                    setPanelOpen(false);
                  } else {
                    handleOpenArtifacts();
                  }
                }}
                title="本会话产物"
              >
                产物 {artifacts.length}
              </button>
            )}

            {messages.length > 0 && (
              <button
                type="button"
                className={
                  "chatview__artifacts-toggle" +
                  (findOpen ? " chatview__artifacts-toggle--active" : "")
                }
                onClick={() => setFindOpen((v) => !v)}
                title="在当前对话中查找 (Ctrl/Cmd+F)"
              >
                查找
              </button>
            )}

            {messages.length > 0 && (
              <button
                type="button"
                className={
                  "chatview__artifacts-toggle" +
                  (fileChangesOpen ? " chatview__artifacts-toggle--active" : "")
                }
                onClick={() => setFileChangesOpen((v) => !v)}
                title="本会话文件变更"
              >
                变更
              </button>
            )}

            {messages.length > 0 && (
              <button
                type="button"
                className={
                  "chatview__artifacts-toggle" +
                  (subagentsOpen ? " chatview__artifacts-toggle--active" : "")
                }
                onClick={() => setSubagentsOpen((v) => !v)}
                title="子代理运行时"
              >
                子代理
              </button>
            )}

            {messages.length > 0 && (
              <button
                type="button"
                className={
                  "chatview__artifacts-toggle" +
                  (teamsOpen ? " chatview__artifacts-toggle--active" : "")
                }
                onClick={() => setTeamsOpen((v) => !v)}
                title="团队状态"
              >
                团队
              </button>
            )}

            {cwd && (
              <button
                type="button"
                className={
                  "chatview__artifacts-toggle" +
                  (panelOpen && panelMode === "fileTree"
                    ? " chatview__artifacts-toggle--active"
                    : "")
                }
                onClick={() => {
                  if (panelOpen && panelMode === "fileTree") {
                    setPanelOpen(false);
                  } else {
                    setPanelMode("fileTree");
                    setPanelOpen(true);
                  }
                }}
                title="工作区文件树"
              >
                文件树
              </button>
            )}

            <button
              type="button"
              className={
                "chatview__artifacts-toggle" +
                (panelOpen && panelMode === "browser"
                  ? " chatview__artifacts-toggle--active"
                  : "")
              }
              onClick={() => {
                if (panelOpen && panelMode === "browser") {
                  setPanelOpen(false);
                } else {
                  setPanelMode("browser");
                  setPanelOpen(true);
                }
              }}
              title="网页预览"
            >
              浏览器
            </button>

            {messages.length > 0 && (
              <ShareMenu messages={messages} title={title} onDone={onToast} />
            )}
          </div>
        </div>

        {plan && plan.entries.length > 0 && planOpen && (
          <div className="chatview__plan-panel">
            <PlanPanel
              sessionId={sessionId ?? undefined}
              onSend={onSend}
              onToast={onToast}
            />
          </div>
        )}

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
          onClose={() => {
            setFindOpen(false);
            setFindQuery("");
            setFindOccurrences([]);
            setFindActive(null);
          }}
          onActiveChange={setFindActive}
        />

        <div className="chatview__scroll-shell">
          <div className="chatview__scroll" ref={scrollRef}>
            <div className="chatview__inner" ref={contentRef}>
              {fileChangesOpen && (
                <FileChangesPanel messages={messages} />
              )}
              {subagentsOpen && (
                <SubagentPanel
                  messages={messages}
                  cwd={cwd}
                  onOpenSession={onOpenSubagentSession ? openSubagentSession : undefined}
                  restorePoint={subagentScrollRestore}
                  onRestoreReady={restoreSubagentRow}
                />
              )}
              {teamsOpen && (
                <TeamStatusView messages={messages} />
              )}
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
                  <div key={m.id} className={"msg-wrap" + findCls} data-msg-id={m.id}>
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
          {streaming && !following && (
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
          {/* Inline permission / question cards: session-scoped, never block sidebar. */}
          <AutomationControls
            sessionId={sessionId}
            streaming={streaming}
            onToast={onToast}
            placement="approval"
          />
          <PermissionInlineCard sessionId={sessionId} />
          <QuestionInlineCard sessionId={sessionId} />
          {control && (
            <div className="yield-banner" role="status">
              <span>
                {control.phase === "pausing" && "正在暂停任务…"}
                {control.phase === "paused" && "已暂停（会话上下文已保留）"}
                {control.phase === "stopping" && "正在停止任务…"}
                {control.phase === "stopped" && "已停止（发送新消息可继续此任务）"}
              </span>
              {(control.phase === "paused" || control.phase === "stopped") && (
                <div className="yield-banner__actions">
                  <button
                    type="button"
                    className="yield-banner__resume"
                    onClick={handleResume}
                    title="恢复会话，等待你发送下一条消息"
                  >
                    {control.phase === "paused" ? "恢复" : "继续此任务"}
                  </button>
                  {control.phase === "paused" && (
                    <button
                      type="button"
                      className="yield-banner__resume yield-banner__resume--primary"
                      onClick={handleResumeAndContinue}
                      title="恢复并发送「请继续」让 Agent 接着生成"
                    >
                      恢复并继续
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
          {/* 流式时提供「暂停」按钮(软停止,区别于停止按钮的硬取消)。 */}
          {sessionId && streaming && !control && (
            <button
              type="button"
              className="chatview__pause-btn"
              onClick={handlePause}
              title="暂停生成(保留会话,可继续)"
            >
              <PauseIcon size="sm" style={{ verticalAlign: "text-bottom" }} /> 暂停
            </button>
          )}
          {/* Rewind / fork: 会话级工具，放在输入框正上方（不再漂浮到左上角挡标题栏）。 */}
          {sessionId && !streaming && (
            <RewindBar
              sessionId={sessionId}
              cwd={cwd}
              onRewound={onRewound}
              onForked={onForked}
              onToast={onToast}
            />
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
            disabled={control?.phase === "pausing" || control?.phase === "paused" || control?.phase === "stopping"}
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
            cwd={newSessionTargetCwd ?? cwd}
            workspaces={workspaces}
            onSelectWorkspace={onSelectWorkspace}
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
            automationModeDisabled={streaming || automationModeChanging}
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
        onClose={() => setPanelOpen(false)}
        onSelectTool={(tc) => {
          setActiveTool(tc);
          setPreviewPath(null);
          setPanelMode("tool");
          setPanelOpen(true);
        }}
        onSelectArtifact={handleSelectArtifact}
        onOpenArtifacts={handleOpenArtifacts}
        findToolCall={(id) => findToolCall(messages, id)}
      />
      {retryDialog}
    </div>
  );
}
