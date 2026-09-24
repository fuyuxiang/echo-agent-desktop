import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import {
  ArrowLeft,
  Code2,
  FolderGit2,
  PanelRightClose,
  PanelRightOpen,
  PanelTop,
  Settings2,
  ShieldCheck,
  Square,
  X,
} from "lucide-react";

import { useAppDialog } from "@/components/AppDialog";
import type { ModelOption } from "@/components/ModelSelector";
import { usePermissionStore } from "@/stores/permission-store";
import { useQuestionStore } from "@/stores/question-store";
import { useSessionStore } from "@/stores/session-store";
import {
  filesystemPickDirectory,
} from "@/lib/agent-client";
import "@/styles/coding-workbench.css";

import { AgentPane } from "./agent/AgentPane";
import { TheiaAgentComposer } from "./agent/TheiaAgentComposer";
import { TheiaIdeFrame, type TheiaAgentBounds, type TheiaIdeFrameHandle, type TheiaMutationTicket } from "./TheiaIdeFrame";
import { TheiaTaskReview } from "./TheiaTaskReview";
import { ChangeSetView } from "./explorer/ChangeSetView";
import { codingTaskDraftKey } from "./lib/hot-exit";
import {
  buildCodingWorkflowPrompt,
  buildNodeContinuationInstruction,
  buildPlanRevisionInstruction,
  mergeTaskVerificationCommands,
} from "./lib/workflow";
import { describePhase, isBusyPhase } from "./lib/phase";
import {
  codingApi,
  onPhaseChanged,
  onVerificationOutput,
  onVerificationUpdated,
  onWorkspaceFileRemoved,
  onWorkspaceFileUpdated,
} from "./lib/tauri-api";
import {
  type DetectedCommand,
} from "./lib/types";
import { useTaskLifecycle } from "./lib/task-lifecycle";
import { useVerificationRunner } from "./lib/use-verification-runner";
import { DeliveryReportTab } from "./main/docs/DeliveryReportTab";
import { VerificationView } from "./panels/VerificationView";
import { ProjectSwitcher } from "./shell/ProjectSwitcher";
import { TaskSwitcher } from "./shell/TaskSwitcher";
import { useTaskStore } from "./store/task-store";
import { fitWorkbenchLayout, useWorkbenchStore } from "./store/workbench-store";

interface CodingWorkbenchProps {
  cwd?: string;
  workspaces?: { cwd: string }[];
  onSelectWorkspace?: (cwd: string) => void;
  /** Recently opened coding projects shown by the current-project switcher. */
  codingWorkspaces?: { cwd: string }[];
  /** Current coding project. One workbench window has one active project. */
  activeCodingWorkspaceCwd?: string;
  /** Remove a path from recent projects without deleting its files. */
  onCloseCodingWorkspace?: (cwd: string) => void;
  onToast?: (message: string) => void;
  onExit?: () => void;
  onRegisterLeaveGuard?: (guard: (() => Promise<boolean>) | null) => void;
  onOpenSettings?: () => void;
  models?: ModelOption[];
  defaultModelId?: string;
  /** True once a model and credentials are configured. */
  apiReady?: boolean;
  /**
   * Session lifecycle stays with the host (App.tsx) so the whole application
   * creates and cancels Agent sessions in one place. Live transcript state is
   * read from the shared stores rather than threaded through props.
   */
  sessionId?: string | null;
  onStartRun?: (
    root: string,
    requirement: string,
    modelId: string | undefined,
    contextPaths: string[],
    onSessionReady: (sessionId: string) => Promise<void>,
    promptTextOverride?: string,
  ) => Promise<string | undefined>;
  /** Focus a task's persisted Agent session without leaving the workbench. */
  onActivateSession?: (sessionId: string, cwd: string) => Promise<void>;
  onChangeModel?: (modelId: string) => void | Promise<void>;
  onSendMessage?: (
    text: string,
    promptTextOverride?: string,
  ) => boolean | void | Promise<boolean | void>;
  onCancelRun?: () => boolean | void | Promise<boolean | void>;
}

interface ManualMutationContext {
  taskId: string | null;
  closeRound: boolean;
}

function basename(path: string): string {
  const segments = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return segments[segments.length - 1] ?? path;
}

function normalizedRelativePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

function workspaceRelativePath(root: string, path: string): string {
  const normalizedRoot = root.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedPath = path.replace(/\\/g, "/");
  if (normalizedPath.startsWith(`${normalizedRoot}/`)) {
    return normalizedRelativePath(normalizedPath.slice(normalizedRoot.length + 1));
  }
  return normalizedRelativePath(normalizedPath);
}
function useElementSize(ref: RefObject<HTMLElement>): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => {
      const rect = element.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        setSize((current) => (
          current.width === rect.width && current.height === rect.height
            ? current
            : { width: rect.width, height: rect.height }
        ));
      }
    };
    update();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(element);
    window.addEventListener("resize", update);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [ref]);

  return size;
}

/**
 * Integrated coding workbench: repository navigation, editing, task-bound Agent
 * execution, verification, review and delivery in one persistent workspace.
 */
export function CodingWorkbench({
  cwd = "",
  workspaces = [],
  onSelectWorkspace,
  onToast,
  onExit,
  onRegisterLeaveGuard,
  onOpenSettings,
  models = [],
  codingWorkspaces,
  activeCodingWorkspaceCwd,
  onCloseCodingWorkspace,
  defaultModelId,
  apiReady = false,
  sessionId: hostSessionId = null,
  onStartRun,
  onActivateSession,
  onChangeModel,
  onSendMessage,
  onCancelRun,
}: CodingWorkbenchProps) {
  // Drive the change set, the baseline and the phase transition off the
  // session's streaming signal — see lib/task-lifecycle for the rationale.
  const { settling: lifecycleSettling } = useTaskLifecycle(cwd);
  const {
    requestConfirmation: requestTaskConfirmation,
    confirm: confirmTaskAction,
    requestInput: requestTaskInput,
    dialog: taskDialog,
  } = useAppDialog(cwd);
  const taskSessionId = useTaskStore((state) => state.task?.sessionId);
  // Never fall back to an unrelated current chat when a coding task has no
  // bound session. An explicit recovery state prevents cross-task sends.
  const activeSessionId = taskSessionId ?? null;
  // Live transcript for the task's session, read straight from the shared store.
  const transcript = useSessionStore((state) =>
    activeSessionId ? state.transcripts[activeSessionId] : undefined,
  );
  const messages = transcript?.messages ?? [];
  const streaming = useSessionStore((state) =>
    activeSessionId ? Boolean(state.transcripts[activeSessionId]?.streamingMessageId) : false,
  );
  const awaitingPermission = usePermissionStore(
    (state) => (activeSessionId ? (state.queues[activeSessionId]?.length ?? 0) > 0 : false),
  );
  const awaitingQuestion = useQuestionStore(
    (state) => (activeSessionId ? (state.queues[activeSessionId]?.length ?? 0) > 0 : false),
  );
  const explorerWidth = useWorkbenchStore((state) => state.explorerWidth);
  const agentWidth = useWorkbenchStore((state) => state.agentWidth);
  const bottomHeight = useWorkbenchStore((state) => state.bottomHeight);
  const hydrateLayout = useWorkbenchStore((state) => state.hydrateLayout);
  const setBottomView = useWorkbenchStore((state) => state.setBottomView);
  const recentCodingProjects = useMemo(() => {
    const paths = [
      activeCodingWorkspaceCwd || cwd,
      ...(codingWorkspaces ?? []).map((workspace) => workspace.cwd),
    ].filter(Boolean);
    return [...new Set(paths)].map((projectCwd) => ({ cwd: projectCwd }));
  }, [activeCodingWorkspaceCwd, codingWorkspaces, cwd]);
  const [theiaPanel, setTheiaPanel] = useState<"agent" | "changes" | "verification">("agent");
  const [theiaActiveFile, setTheiaActiveFile] = useState<string | null>(null);
  const [theiaReviewPath, setTheiaReviewPath] = useState<string | null>(null);
  const [theiaReportOpen, setTheiaReportOpen] = useState(false);
  const [theiaPreviewInput, setTheiaPreviewInput] = useState("");
  const [theiaPreviewOpen, setTheiaPreviewOpen] = useState(false);
  const [theiaAgentOpen, setTheiaAgentOpen] = useState(true);
  const [theiaAgentBounds, setTheiaAgentBounds] = useState<TheiaAgentBounds | null>(null);
  const [theiaDirtyCount, setTheiaDirtyCount] = useState<number | null>(null);
  const theiaFrameRef = useRef<TheiaIdeFrameHandle>(null);
  const visibleDirtyCount = theiaDirtyCount ?? 0;
  const theiaPreviewRef = useRef<HTMLDivElement>(null);
  const [theiaPreviewRequest, setTheiaPreviewRequest] = useState<{ url: string; id: number } | null>(null);
  const [theiaOpenFileRequest, setTheiaOpenFileRequest] = useState<{ path: string; id: number; line?: number } | null>(null);
  const openTheiaFile = useCallback((rawPath: string, line?: number) => {
    const root = cwd.replaceAll("\\", "/").replace(/\/+$/, "");
    const path = rawPath.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/\.\//g, "/");
    if (!path || path.split("/").includes("..")) {
      onToast?.("文件路径无效");
      return;
    }
    const absolute = path.startsWith("/") || /^[A-Za-z]:\//.test(path) ? path : `${root}/${path}`;
    const compareRoot = /^[A-Za-z]:\//.test(root) ? root.toLowerCase() : root;
    const comparePath = /^[A-Za-z]:\//.test(absolute) ? absolute.toLowerCase() : absolute;
    if (!comparePath.startsWith(`${compareRoot}/`)) {
      onToast?.("只能打开当前项目内的文件");
      return;
    }
    setTheiaOpenFileRequest({ path: absolute, line, id: Date.now() });
  }, [cwd, onToast]);
  const [theiaVerificationOutput, setTheiaVerificationOutput] = useState("");
  useEffect(() => {
    if (!theiaPreviewOpen) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!theiaPreviewRef.current?.contains(event.target as Node)) setTheiaPreviewOpen(false);
    };
    document.addEventListener("mousedown", closeOnOutsideClick);
    return () => document.removeEventListener("mousedown", closeOnOutsideClick);
  }, [theiaPreviewOpen]);
  const [contextPaths, setContextPaths] = useState<string[]>([]);
  const [modelId, setModelId] = useState(defaultModelId);
  const [startError, setStartError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [sending, setSending] = useState(false);
  const [phaseReason, setPhaseReason] = useState<string>();
  const [blocker, setBlocker] = useState<string | null | undefined>(undefined);
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [committing, setCommitting] = useState(false);
  const [detected, setDetected] = useState<DetectedCommand[]>([]);
  const [detectedReady, setDetectedReady] = useState(false);
  const [commandOutput, setCommandOutput] = useState("");
  const [reportRevision, setReportRevision] = useState(0);
  const repairPromptRef = useRef<string | null>(null);
  const workflowActionRef = useRef<string | null>(null);
  const taskSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contextSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const workbenchRef = useRef<HTMLDivElement>(null);
  const workbenchSize = useElementSize(workbenchRef);

  const task = useTaskStore((state) => state.task);
  const summaries = useTaskStore((state) => state.summaries);
  const changeSet = useTaskStore((state) => state.changeSet);
  const problems = useTaskStore((state) => state.problems);
  const ledger = useTaskStore((state) => state.ledger);
  const verifications = useTaskStore((state) => state.verifications);
  const orchestrator = useTaskStore((state) => state.orchestrator);
  const activeTaskCount = useMemo(() => {
    const activeIds = new Set(
      summaries
        .filter((summary) => isBusyPhase(summary.phase))
        .map((summary) => summary.id),
    );
    // The detail record can be newer than the summary list immediately after
    // a phase transition. Count it as well so navigation can never create a
    // brief window in which an active task is accidentally abandoned.
    if (task && isBusyPhase(task.phase)) activeIds.add(task.id);
    return activeIds.size;
  }, [summaries, task]);
  const verificationCommands = useMemo(
    () => mergeTaskVerificationCommands(detected, task),
    [detected, task],
  );
  const {
    activeRunId,
    activeRunIdRef,
    runningVerification,
    runVerifications,
  } = useVerificationRunner({
    cwd,
    task,
    commands: verificationCommands,
    detectedReady,
    setBottomView,
    setCommandOutput,
    requestConfirmation: requestTaskConfirmation,
    onToast,
  });

  useEffect(() => {
    if (runningVerification) setTheiaVerificationOutput("");
  }, [runningVerification]);
  useEffect(() => {
    setTheiaReviewPath(null);
    setTheiaReportOpen(false);
  }, [cwd, task?.id]);

  useEffect(() => {
    setPhaseReason(undefined);
    setBlocker(undefined);
  }, [task?.id]);

  useEffect(() => setModelId(defaultModelId), [defaultModelId]);

  // Bind the task store to this workspace and load its task list.
  useEffect(() => {
    useTaskStore.getState().setRoot(cwd);
    if (cwd) void useTaskStore.getState().refreshSummaries();
  }, [cwd]);

  // Task context is owned by the task, not by whichever repository happened to
  // be visible when the user pinned it. A new-task draft starts empty.
  useEffect(() => {
    if (task) setContextPaths(task.contextPaths ?? []);
  }, [task?.id]);

  /**
   * The orchestrator is the only authority on phase, so the UI reacts to its
   * events instead of inferring progress from the message stream.
   */
  useEffect(() => {
    if (!cwd) return;
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    void onPhaseChanged((event) => {
      if (disposed || event.root !== cwd) return;
      useTaskStore.getState().applyPhase(event.taskId, event.phase);
      if (useTaskStore.getState().task?.id === event.taskId) {
        setPhaseReason(event.reason);
        setBlocker(event.blocker ?? null);
      }
      setReportRevision((value) => value + 1);
      void useTaskStore.getState().refreshTaskState();
    }).then((unlisten) => {
      if (disposed) unlisten();
      else unlisteners.push(unlisten);
    });
    void onVerificationUpdated((record) => {
      if (disposed || useTaskStore.getState().task?.id !== record.taskId) return;
      useTaskStore.getState().applyVerification(record);
    }).then((unlisten) => {
      if (disposed) unlisten();
      else unlisteners.push(unlisten);
    });
    void onVerificationOutput((event) => {
      if (
        disposed
        || event.root !== cwd
        || useTaskStore.getState().task?.id !== event.taskId
        || activeRunIdRef.current !== event.runId
      ) return;
      // Cap retained output so a verbose build cannot grow the renderer's memory.
      setCommandOutput((current) => {
        const next = current + event.chunk;
        return next.length > 400_000 ? `…较早输出已省略…\n${next.slice(-400_000)}` : next;
      });
    }).then((unlisten) => {
      if (disposed) unlisten();
      else unlisteners.push(unlisten);
    });
    return () => {
      disposed = true;
      for (const unlisten of unlisteners) unlisten();
    };
  }, [cwd]);

  // Re-detect at phase boundaries as well as workspace open. An implementation
  // may add/remove package scripts or manifests, so a cached command list is
  // not valid evidence for the new source tree.
  useEffect(() => {
    if (!cwd) {
      setDetected([]);
      setDetectedReady(false);
      return;
    }
    let cancelled = false;
    setDetectedReady(false);
    void codingApi
      .detectCommands(cwd)
      .then((commands) => {
        if (!cancelled) setDetected(commands);
      })
      .catch(() => {
        if (!cancelled) setDetected([]);
      })
      .finally(() => {
        if (!cancelled) setDetectedReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [cwd, task?.phase, task?.phase === "verifying" ? task.updatedAt : null]);

  const prepareManualMutation = useCallback(async (): Promise<ManualMutationContext | null> => {
    const activeTask = useTaskStore.getState().task;
    if (!activeTask) return { taskId: null, closeRound: false };
    if (["discovering", "implementing", "repairing"].includes(activeTask.phase)) {
      return { taskId: activeTask.id, closeRound: false };
    }
    if (["paused", "stopped", "blocked", "delivered"].includes(activeTask.phase)) {
      try {
        await codingApi.beginFollowup(cwd, activeTask.id, "用户在编辑器中继续修改工程文件");
        await useTaskStore.getState().refreshTaskState();
        return { taskId: activeTask.id, closeRound: true };
      } catch (error) {
        onToast?.(`当前任务不能继续编辑：${String(error).replace(/^Error:\s*/, "")}`);
        return null;
      }
    }
    onToast?.(activeTask.phase === "verifying"
      ? "正在验证当前改动，请等待验证结束后再编辑"
      : "当前任务阶段不能修改文件");
    return null;
  }, [cwd, onToast]);

  const finishManualMutation = useCallback(async (context: ManualMutationContext) => {
    if (!context.taskId) return;
    await codingApi.syncChanges(cwd, context.taskId);
    if (context.closeRound) {
      await codingApi.reportImplementation(cwd, context.taskId);
    }
    await useTaskStore.getState().refreshTaskState();
  }, [cwd]);

  const blockInterruptedManualMutation = useCallback(async (
    context: ManualMutationContext,
    reason: string,
  ) => {
    if (!context.taskId || !context.closeRound) return;
    await codingApi.reportStartFailed(cwd, context.taskId, reason).catch(() => undefined);
    await useTaskStore.getState().refreshTaskState().catch(() => undefined);
  }, [cwd]);

  const saveTheiaBeforeLeaving = useCallback(async (): Promise<boolean> => {
    if (activeTaskCount > 0) {
      onToast?.("当前开发任务仍在执行，请先停止任务再离开代码开发");
      return false;
    }
    if (!cwd) return true;
    let dirtyCount: number;
    try {
      dirtyCount = await theiaFrameRef.current?.getDirtyCount() ?? -1;
    } catch (error) {
      return confirmTaskAction({
        title: "无法确认 IDE 文件状态",
        description: `${String(error).replace(/^Error:\s*/, "")}。继续离开可能丢失未保存的编辑内容。`,
        confirmLabel: "仍要离开",
        danger: true,
      });
    }
    if (dirtyCount < 0) return false;
    setTheiaDirtyCount(dirtyCount);
    if (dirtyCount === 0) return true;
    const confirmed = await confirmTaskAction({
      title: `保存 ${dirtyCount} 个文件后离开？`,
      description: "当前 IDE 有未保存的编辑内容。保存成功后继续，保存失败时会留在当前项目。",
      confirmLabel: "保存并继续",
    });
    if (!confirmed) return false;
    try {
      const saved = await theiaFrameRef.current?.saveAll();
      if (saved) return true;
      return confirmTaskAction({
        title: "仍有文件未保存",
        description: "IDE 中仍有未保存的文件。继续离开会放弃这些编辑内容。",
        confirmLabel: "放弃并离开",
        danger: true,
      });
    } catch (error) {
      return confirmTaskAction({
        title: "IDE 文件保存失败",
        description: `${String(error).replace(/^Error:\s*/, "")}。继续离开会放弃未保存的编辑内容。`,
        confirmLabel: "放弃并离开",
        danger: true,
      });
    }
  }, [activeTaskCount, confirmTaskAction, cwd, onToast]);

  useEffect(() => {
    onRegisterLeaveGuard?.(saveTheiaBeforeLeaving);
    return () => onRegisterLeaveGuard?.(null);
  }, [onRegisterLeaveGuard, saveTheiaBeforeLeaving]);

  const exitSafely = useCallback(async () => {
    if (!(await saveTheiaBeforeLeaving())) return;
    onExit?.();
  }, [onExit, saveTheiaBeforeLeaving]);

  const switchProject = useCallback(async (nextCwd: string) => {
    if (!nextCwd || nextCwd === cwd) return;
    if (activeTaskCount > 0) {
      onToast?.(
        activeTaskCount === 1
          ? "当前开发任务仍在执行，请先停止任务再切换项目"
          : `当前项目有 ${activeTaskCount} 个任务仍在执行，请先停止后再切换项目`,
      );
      return;
    }
    if (cwd && !(await saveTheiaBeforeLeaving())) return;
    onSelectWorkspace?.(nextCwd);
  }, [activeTaskCount, cwd, onSelectWorkspace, onToast, saveTheiaBeforeLeaving]);

  const pickWorkspace = useCallback(async () => {
    try {
      const picked = await filesystemPickDirectory();
      if (picked) await switchProject(picked);
    } catch (error) {
      onToast?.(`打开文件夹失败：${String(error).replace(/^Error:\s*/, "")}`);
    }
  }, [onToast, switchProject]);

  const openAnotherProject = useCallback(() => {
    if (activeTaskCount > 0) {
      onToast?.("当前开发任务仍在执行，请先停止任务再打开其他文件夹");
      return;
    }
    void pickWorkspace();
  }, [activeTaskCount, onToast, pickWorkspace]);

  const removeRecentProject = useCallback(async (projectCwd: string) => {
    if (projectCwd === cwd && activeTaskCount > 0) {
      onToast?.("当前开发任务仍在执行，请先停止任务再移除项目");
      return;
    }
    if (projectCwd === cwd && !(await saveTheiaBeforeLeaving())) return;
    onCloseCodingWorkspace?.(projectCwd);
  }, [activeTaskCount, cwd, onCloseCodingWorkspace, onToast, saveTheiaBeforeLeaving]);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      const dirty = Boolean(cwd) && (theiaDirtyCount === null || theiaDirtyCount > 0);
      if (!dirty && activeTaskCount === 0) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [activeTaskCount, cwd, theiaDirtyCount]);

  const queueTaskChangeSync = useCallback(() => {
    const taskId = useTaskStore.getState().task?.id;
    if (!cwd || !taskId) return;
    if (taskSyncTimerRef.current !== null) clearTimeout(taskSyncTimerRef.current);
    taskSyncTimerRef.current = setTimeout(() => {
      taskSyncTimerRef.current = null;
      if (useTaskStore.getState().root !== cwd || useTaskStore.getState().task?.id !== taskId) return;
      void codingApi.syncChanges(cwd, taskId)
        .then(() => {
          if (useTaskStore.getState().root !== cwd || useTaskStore.getState().task?.id !== taskId) return;
          return useTaskStore.getState().refreshTaskState();
        })
        .then(() => {
          if (useTaskStore.getState().root === cwd && useTaskStore.getState().task?.id === taskId) {
            setReportRevision((value) => value + 1);
          }
        })
        .catch((error) => onToast?.(`同步任务变更失败：${String(error).replace(/^Error:\s*/, "")}`));
    }, 300);
  }, [cwd, onToast]);

  useEffect(() => () => {
    if (taskSyncTimerRef.current !== null) clearTimeout(taskSyncTimerRef.current);
    taskSyncTimerRef.current = null;
  }, [cwd, task?.id]);

  // Keep clean editor tabs live for every workspace file type. If the user is
  // reviewing a diff, refresh the task-baseline comparison after the disk
  // snapshot is reconciled instead of silently falling back to identical panes.
  useEffect(() => {
    if (!cwd) return;
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    void onWorkspaceFileUpdated((event) => {
      if (disposed || event.root !== cwd) return;
      queueTaskChangeSync();
    }).then((unlisten) => {
      if (disposed) unlisten();
      else unlisteners.push(unlisten);
    });
    void onWorkspaceFileRemoved((event) => {
      if (disposed || event.root !== cwd) return;
      queueTaskChangeSync();
    }).then((unlisten) => {
      if (disposed) unlisten();
      else unlisteners.push(unlisten);
    });
    return () => {
      disposed = true;
      for (const unlisten of unlisteners) unlisten();
    };
  }, [cwd, queueTaskChangeSync]);

  useEffect(() => {
    hydrateLayout();
  }, [hydrateLayout]);

  const effectiveLayout = useMemo(
    () => fitWorkbenchLayout(workbenchSize.width, workbenchSize.height, {
      explorerWidth,
      agentWidth,
      bottomHeight,
    }),
    [agentWidth, bottomHeight, explorerWidth, workbenchSize.height, workbenchSize.width],
  );
  /** Derive a task name from the requirement's first clause. */
  const deriveName = useCallback((requirement: string) => {
    const firstLine = requirement.split(/[\n。；;]/)[0]?.trim() ?? requirement.trim();
    return firstLine.length > 24 ? `${firstLine.slice(0, 24)}…` : firstLine || "开发任务";
  }, []);

  /**
   * Create the task, then hand the requirement to the host so it can open an
   * Agent session. The orchestrator records the phase transition; the workbench
   * never decides it locally.
   */
  const startTask = useCallback(
    async (
      requirement: string,
      _documentationTarget?: unknown,
      additionalContextPaths: string[] = [],
    ) => {
      if (!cwd || !onStartRun) return;
      const trimmedRequirement = requirement.trim();
      if (!trimmedRequirement) {
        setStartError("请输入任务目标后再开始");
        return;
      }
      setStarting(true);
      setStartError(null);
      let createdId: string | undefined;
      try {
        const effectiveContextPaths = [...new Set([
          ...contextPaths,
          ...additionalContextPaths,
        ].map((path) => workspaceRelativePath(cwd, path)).filter(Boolean))];
        const created = await useTaskStore.getState().createTask(
          deriveName(trimmedRequirement),
          trimmedRequirement,
        );
        if (!created) {
          setStartError(useTaskStore.getState().error ?? "创建任务失败");
          return;
        }
        createdId = created.id;
        try {
          localStorage.removeItem(codingTaskDraftKey(cwd));
        } catch {
          // Task creation succeeded; draft cleanup is best-effort.
        }
        await codingApi.setTaskContext(cwd, created.id, effectiveContextPaths);
        // Persist a task-start checkpoint before the Agent can touch the
        // workspace. Git repositories get HEAD protection; ordinary folders
        // get an application-owned filesystem checkpoint.
        await codingApi.captureBaseline(cwd, created.id, []);
        await codingApi.submitRequirement(cwd, created.id);
        let boundSession: string | undefined;
        const bindSession = async (sessionId: string) => {
          if (boundSession && boundSession !== sessionId) {
            throw new Error("任务收到了不一致的 Agent 会话标识");
          }
          await codingApi.bindTaskRuntime(cwd, created.id, sessionId, modelId ?? "");
          await useTaskStore.getState().selectTask(created.id);
          boundSession = sessionId;
        };
        const session = await onStartRun(
          cwd,
          trimmedRequirement,
          modelId,
          effectiveContextPaths,
          bindSession,
          buildCodingWorkflowPrompt(trimmedRequirement, effectiveContextPaths, false),
        );
        if (!session) {
          const reason = "未能启动 Agent 会话，任务已停止且不会继续执行";
          await codingApi.reportStartFailed(cwd, created.id, reason).catch(() => undefined);
          setStartError(reason);
          await useTaskStore.getState().refreshTaskState();
          return;
        }
        if (boundSession !== session) {
          throw new Error("Agent 返回的会话与已绑定会话不一致");
        }
      } catch (error) {
        const reason = String(error).replace(/^Error:\s*/, "");
        if (createdId) {
          await codingApi.reportStartFailed(cwd, createdId, reason).catch(() => undefined);
          await useTaskStore.getState().refreshTaskState().catch(() => undefined);
        }
        setStartError(reason);
      } finally {
        setStarting(false);
      }
    },
    [contextPaths, cwd, deriveName, modelId, onStartRun],
  );

  const sendFollowup = useCallback(
    async (text: string, mutating = true, managedPrompt?: string) => {
      if (!onSendMessage) return false;
      if (
        !task?.sessionId
        || activeSessionId !== task.sessionId
        || hostSessionId !== task.sessionId
      ) {
        onToast?.("当前任务没有可用的 Agent 会话，请重新选择该任务或新建任务");
        return false;
      }
      setSending(true);
      let reopened = false;
      try {
        if (mutating && task) {
          if (["paused", "stopped", "blocked", "delivered"].includes(task.phase)) {
            if (!cwd) return false;
            await codingApi.beginFollowup(cwd, task.id, text);
            await useTaskStore.getState().refreshTaskState();
            reopened = true;
          } else if (
            !["discovering", "implementing", "repairing"].includes(task.phase)
          ) {
            onToast?.(task.phase === "verifying"
              ? "正在验证当前改动，请等待验证结束后再补充开发要求"
              : "当前任务阶段不能修改代码");
            return false;
          }
        }
        const effectiveContextPaths = [...new Set(contextPaths)];
        const promptTextOverride = managedPrompt ?? (task
          ? buildCodingWorkflowPrompt(
              text,
              effectiveContextPaths,
              true,
            )
          : undefined);
        const accepted = await onSendMessage(text, promptTextOverride);
        if (accepted === false && reopened) {
          await blockInterruptedManualMutation(
            { taskId: task.id, closeRound: true },
            "Agent 未接收补充要求",
          );
        }
        return accepted !== false;
      } catch (error) {
        const message = String(error).replace(/^Error:\s*/, "");
        if (reopened) {
          await blockInterruptedManualMutation(
            { taskId: task.id, closeRound: true },
            `Agent 补充要求发送失败：${message}`,
          );
        }
        onToast?.(`无法继续当前任务：${message}`);
        return false;
      } finally {
        setSending(false);
      }
    },
    [
      activeSessionId,
      blockInterruptedManualMutation,
      contextPaths,
      cwd,
      hostSessionId,
      onSendMessage,
      onToast,
      task,
    ],
  );

  const activateCodingTask = useCallback(async (taskId: string) => {
    if (task?.id !== taskId && task && isBusyPhase(task.phase)) {
      onToast?.("当前任务正在执行，请先停止后再切换任务");
      return;
    }
    setSending(true);
    try {
      await useTaskStore.getState().selectTask(taskId);
      setTheiaPanel("agent");
      const selected = useTaskStore.getState().task;
      setContextPaths(selected?.contextPaths ?? []);
      if (selected?.sessionId) {
        await onActivateSession?.(selected.sessionId, cwd);
        if (selected.modelId) setModelId(selected.modelId);
      }
    } catch (error) {
      onToast?.(`恢复任务会话失败：${String(error).replace(/^Error:\s*/, "")}`);
    } finally {
      setSending(false);
    }
  }, [cwd, onActivateSession, onToast, task]);

  const beginNewTask = useCallback(() => {
    if (activeTaskCount > 0) {
      onToast?.(`当前项目有 ${activeTaskCount} 个任务仍在执行，请先停止后再新建任务`);
      return;
    }
    useTaskStore.setState({
      task: null,
      changeSet: null,
      verifications: [],
      problems: [],
      ledger: [],
      orchestrator: null,
    });
    setContextPaths([]);
    setTheiaPanel("agent");
    setPhaseReason(undefined);
    setBlocker(undefined);
  }, [activeTaskCount, onToast]);

  const persistTaskContext = useCallback((taskId: string, paths: string[]) => {
    // Tauri invocations may complete out of order. Serialize context writes so
    // rapid add/remove actions cannot resurrect an older selection on disk.
    contextSaveQueueRef.current = contextSaveQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        await codingApi.setTaskContext(cwd, taskId, paths);
      })
      .catch((error) => {
        onToast?.(`保存任务上下文失败：${String(error).replace(/^Error:\s*/, "")}`);
      });
  }, [cwd, onToast]);

  /** SP3: «加入上下文» — push selected paths into `contextPaths`. */
  const addManyToContext = useCallback((paths: string[]) => {
    if (paths.length === 0) return;
    setContextPaths((current) => {
      const normalized = paths
        .map((path) => workspaceRelativePath(cwd, path))
        .filter(Boolean);
      const next = [...new Set([...current, ...normalized])];
      if (task) {
        persistTaskContext(task.id, next);
      }
      return next;
    });
    onToast?.(`已添加 ${paths.length} 个到${task ? "当前任务" : "新任务"}上下文`);
  }, [cwd, onToast, persistTaskContext, task]);

  const removeFromContext = useCallback((path: string) => {
    setContextPaths((current) => {
      const next = current.filter((entry) => entry !== path);
      if (task) {
        persistTaskContext(task.id, next);
      }
      return next;
    });
  }, [persistTaskContext, task]);

  const renameCodingTask = useCallback((
    summary: (typeof summaries)[number],
    returnFocus?: HTMLElement | null,
  ) => {
    requestTaskInput({
      title: "重命名开发任务",
      description: "任务名称只用于识别和切换，不会改变原始需求或 Agent 会话。",
      confirmLabel: "保存",
      returnFocus,
      fields: [{
        name: "name",
        label: "任务名称",
        defaultValue: summary.name,
        required: true,
        maxLength: 120,
      }],
      validate: (values) => values.name.trim() === summary.name
        ? "请输入与当前名称不同的新名称。"
        : null,
      action: async (values) => {
        await useTaskStore.getState().renameTask(summary.id, values.name.trim());
        onToast?.("任务已重命名");
      },
      onError: (error) => onToast?.(`重命名失败：${String(error).replace(/^Error:\s*/, "")}`),
    });
  }, [onToast, requestTaskInput, summaries]);

  const deleteCodingTask = useCallback((
    summary: (typeof summaries)[number],
    returnFocus?: HTMLElement | null,
  ) => {
    if (isBusyPhase(summary.phase)) {
      onToast?.("任务正在执行或验证，请先停止后再删除");
      return;
    }
    const index = summaries.findIndex((entry) => entry.id === summary.id);
    const fallback = summaries[index + 1] ?? summaries[index - 1];
    const wasActive = task?.id === summary.id;
    requestTaskConfirmation({
      title: `删除开发任务「${summary.name}」？`,
      description: (
        <>
          将删除该任务的执行计划、差异基线、验证记录和交付报告。
          <br />
          工作区源码和绑定的 Agent 会话不会被删除。
        </>
      ),
      confirmLabel: "删除任务",
      danger: true,
      returnFocus,
      action: async () => {
        await useTaskStore.getState().deleteTask(summary.id);
        if (wasActive) {
          setPhaseReason(undefined);
          setBlocker(undefined);
          if (fallback) await activateCodingTask(fallback.id);
        }
        onToast?.("已删除开发任务，工作区文件和 Agent 会话均已保留");
      },
      onError: (error) => onToast?.(`删除任务失败：${String(error).replace(/^Error:\s*/, "")}`),
    });
  }, [activateCodingTask, onToast, requestTaskConfirmation, summaries, task?.id]);

  const continueInterruptedTask = useCallback(async () => {
    if (
      !cwd
      || !task
      || (task.phase !== "paused" && task.phase !== "stopped")
      || sending
      || streaming
      || lifecycleSettling
    ) return;
    if (
      !onSendMessage
      || !task.sessionId
      || activeSessionId !== task.sessionId
      || hostSessionId !== task.sessionId
    ) {
      onToast?.("当前任务的 Agent 会话尚未完成恢复，请重新选择该任务后再试");
      return;
    }
    const interruptedAs = task.phase;
    let resumed = false;
    setSending(true);
    try {
      const resumedTask = await codingApi.resumeTask(cwd, task.id);
      resumed = true;
      await useTaskStore.getState().refreshTaskState();
      const activeNode = resumedTask.taskNodes.find((node) => node.status === "running");
      const prompt = activeNode
        ? buildNodeContinuationInstruction(resumedTask, activeNode)
        : buildCodingWorkflowPrompt(`继续完成原始需求：${resumedTask.requirement}`, contextPaths, true);
      const accepted = await onSendMessage("继续执行当前开发任务", prompt);
      if (accepted === false) throw new Error("Agent 未接收继续执行请求");
    } catch (error) {
      if (resumed) {
        await codingApi
          .reportInterrupted(cwd, task.id, interruptedAs)
          .catch(() => undefined);
        await useTaskStore.getState().refreshTaskState().catch(() => undefined);
      }
      onToast?.(`无法继续当前任务：${String(error).replace(/^Error:\s*/, "")}`);
    } finally {
      setSending(false);
    }
  }, [
    activeSessionId,
    contextPaths,
    cwd,
    hostSessionId,
    lifecycleSettling,
    onSendMessage,
    onToast,
    sending,
    streaming,
    task,
  ]);

  const stopActiveTask = useCallback(async () => {
    if (!cwd || !task || !isBusyPhase(task.phase)) return;
    try {
      if (activeRunId) await codingApi.cancelVerification(activeRunId);
      const cancelled = await onCancelRun?.();
      if (streaming && cancelled === false) return;
      // A streaming turn is finalized by useTaskLifecycle when its stream
      // falls. Scheduler/verification phases without a stream need an explicit
      // persisted interruption so the stop control always has an effect.
      if (!streaming) {
        await codingApi.reportInterrupted(cwd, task.id, "stopped");
        await useTaskStore.getState().refreshTaskState();
      }
    } catch (error) {
      onToast?.(`停止任务失败：${String(error).replace(/^Error:\s*/, "")}`);
    }
  }, [activeRunId, cwd, onCancelRun, onToast, streaming, task]);

  // The backend is the scheduler. A managed follow-up is sent only for its
  // explicit persisted nextAction, so closing/reopening the app resumes the
  // exact unfinished node without relying on renderer timing or local guesses.
  useEffect(() => {
    if (
      !cwd
      || !task?.nextAction
      || !task.sessionId
      || activeSessionId !== task.sessionId
      || hostSessionId !== task.sessionId
      || streaming
      || sending
      || awaitingPermission
      || awaitingQuestion
      || !onSendMessage
    ) return;
    const key = `${task.id}:${task.updatedAt}:${task.nextAction}`;
    if (workflowActionRef.current === key) return;

    const activeNode = task.taskNodes.find((node) => node.status === "running");
    if (task.nextAction === "continue_node" && !activeNode) {
      workflowActionRef.current = key;
      void codingApi
        .reportStartFailed(cwd, task.id, "调度器要求继续执行，但没有找到运行中的节点")
        .then(() => useTaskStore.getState().refreshTaskState())
        .catch(() => undefined);
      return;
    }

    workflowActionRef.current = key;
    const displayText = task.nextAction === "revise_plan"
      ? "正在根据结构校验结果修订执行计划"
      : `继续执行 ${activeNode?.planKey ?? "下一节点"}`;
    const prompt = task.nextAction === "revise_plan"
      ? buildPlanRevisionInstruction(task)
      : buildNodeContinuationInstruction(task, activeNode!);
    void sendFollowup(displayText, false, prompt).then(async (accepted) => {
      if (accepted) return;
      await codingApi
        .reportStartFailed(cwd, task.id, "Agent 未能接收自动续跑指令")
        .catch(() => undefined);
      await useTaskStore.getState().refreshTaskState().catch(() => undefined);
    });
  }, [
    activeSessionId,
    awaitingPermission,
    awaitingQuestion,
    cwd,
    hostSessionId,
    onSendMessage,
    sendFollowup,
    sending,
    streaming,
    task,
  ]);

  const rollbackTask = useCallback(async () => {
    if (!cwd || !task) return;
    const count = changeSet?.changes.length ?? 0;
    const confirmed = await confirmTaskAction({
      title: `回滚当前任务的 ${count} 个文件？`,
      description: "将精确恢复任务开始时的内容。IDE 会在文件系统事件后刷新对应文件。",
      confirmLabel: "回滚任务",
      danger: true,
    });
    if (!confirmed) return;
    try {
      const restored = await codingApi.rollbackTask(cwd, task.id);
      await useTaskStore.getState().refreshTaskState();
      onToast?.(`已回滚 ${restored.length} 个文件`);
    } catch (error) {
      onToast?.(`回滚失败：${String(error).replace(/^Error:\s*/, "")}`);
    }
  }, [changeSet?.changes.length, confirmTaskAction, cwd, onToast, task]);

  const discardChange = useCallback(
    async (path: string) => {
      if (!cwd || !task) return;
      const confirmed = await confirmTaskAction({
        title: `丢弃 ${path} 的全部改动？`,
        description: "该文件将恢复为任务开始时的内容，IDE 会在文件系统事件后刷新。",
        confirmLabel: "丢弃改动",
        danger: true,
      });
      if (!confirmed) return;
      const mutation = await prepareManualMutation();
      if (!mutation) return;
      setBusyPath(path);
      try {
        await codingApi.discardFile(cwd, task.id, path);
        await finishManualMutation(mutation);
      } catch (error) {
        const message = String(error).replace(/^Error:\s*/, "");
        await blockInterruptedManualMutation(mutation, `丢弃文件改动失败：${message}`);
        onToast?.(`丢弃失败：${message}`);
      } finally {
        setBusyPath(null);
      }
    },
    [
      blockInterruptedManualMutation,
      confirmTaskAction,
      cwd,
      finishManualMutation,
      onToast,
      prepareManualMutation,
      task,
    ],
  );

  const commitChanges = useCallback(async () => {
    if (!cwd || !task) return;
    try {
      const input = await codingApi.commitInput(cwd, task.id);
      requestTaskInput({
        title: "提交任务变更",
        description: `将提交 ${changeSet?.changes.length ?? 0} 个已通过交付门禁的任务文件。`,
        confirmLabel: "创建提交",
        fields: [{
          name: "message",
          label: "提交信息",
          defaultValue: input.split("\n")[0]?.replace(/^任务名称：/, "") ?? "",
          required: true,
          maxLength: 200,
        }],
        action: async (values) => {
          setCommitting(true);
          try {
            const hash = await codingApi.commit(cwd, task.id, values.message.trim());
            await useTaskStore.getState().refreshTaskState();
            onToast?.(`已提交 ${hash.slice(0, 8)}`);
          } finally {
            setCommitting(false);
          }
        },
        onError: (error) => onToast?.(`提交失败：${String(error).replace(/^Error:\s*/, "")}`),
      });
    } catch (error) {
      onToast?.(`提交失败：${String(error).replace(/^Error:\s*/, "")}`);
    }
  }, [changeSet?.changes.length, cwd, onToast, requestTaskInput, task]);

  // A failed verification opens a repair round. Feed the structured problem
  // list back to the exact task session once, then the lifecycle hook observes
  // that repair turn finishing and re-enters verification.
  useEffect(() => {
    if (task?.phase !== "repairing") {
      repairPromptRef.current = null;
      return;
    }
    if (!task.sessionId || hostSessionId !== task.sessionId || streaming || !onSendMessage) return;
    const round = orchestrator?.repairRounds.length ?? 0;
    // Documentation safety repairs are opened before command verification, so
    // they do not create a regular repair round. Include their ledger revision
    // to ensure a second failed safety pass can trigger the next repair turn.
    const documentationAttempt = ledger.filter(
      (event) => event.kind === "documentation_validation_requested",
    ).length;
    const key = `${task.id}:${round}:${documentationAttempt}`;
    if (repairPromptRef.current === key) return;
    repairPromptRef.current = key;
    const documentationSafetyFailure = problems.some(
      (problem) => problem.kind === "documentation",
    );
    const documentationMissingWrite = problems.some(
      (problem) => problem.kind === "documentation" && problem.message.includes("未产生任何文件变更"),
    );
    const readOnlyWrite = problems.some(
      (problem) => problem.kind === "documentation" && problem.message.includes("只读代码解释任务"),
    );
    const documentationMissingOutput = problems.some(
      (problem) => problem.kind === "documentation" && problem.message.includes("变更集中没有"),
    );
    const details = problems.length > 0
      ? problems.map((problem, index) =>
          `${index + 1}. [${problem.kind}] ${problem.file ?? "未知文件"}${problem.line ? `:${problem.line}` : ""} — ${problem.message}`,
        ).join("\n")
      : "验证未通过，但未能提取结构化诊断。请查看验证输出并定位根因。";
    let instruction = "上一轮验证未通过，请修复下列问题。必须检查真实命令输出、完成代码修改并保持现有功能兼容；修复完成后简要说明。";
    if (readOnlyWrite) {
      instruction = "这是只读代码解释任务，但上一轮修改了工程文件。请撤销本轮产生的全部文件变更，保留对话中的证据化分析；不要创建文档来制造交付物。完成后说明已恢复哪些文件。";
    } else if (documentationMissingWrite) {
      instruction = "你尚未把注释或文档写入工程。请重新读取原始目标和真实代码，把必要内容直接写入目标文件；不要只在对话中给出示例或完成说明，不要改变可执行逻辑。完成后简要说明实际修改位置。";
    } else if (documentationMissingOutput) {
      instruction = "当前变更没有覆盖用户明确要求的全部文档产物。请重新核对原始需求，在保持现有正确注释和不改变可执行逻辑的前提下，补齐缺失的源码注释或架构文档，然后检查真实差异。";
    } else if (documentationSafetyFailure) {
      instruction = "注释安全校验发现了超出用户要求的代码变更。请只撤销可执行逻辑、字面量或公共结构的改动，保留正确的注释和文档；不要用改写业务代码的方式绕过校验。完成后简要说明。";
    }
    sendFollowup(`${instruction}\n\n${details}`);
  }, [
    hostSessionId,
    ledger,
    onSendMessage,
    orchestrator?.repairRounds.length,
    problems,
    sendFollowup,
    streaming,
    task,
  ]);

  const changeTaskModel = useCallback(async (nextModelId: string) => {
    const previous = modelId;
    setModelId(nextModelId);
    // The starter's choice belongs to the next coding session. Do not mutate
    // an unrelated chat session merely because it was active before Echo Code
    // opened; `startTask` passes this explicit model to the new session.
    if (!task) return;
    try {
      if (!task.sessionId || hostSessionId !== task.sessionId) {
        throw new Error("任务会话尚未完成恢复");
      }
      await onChangeModel?.(nextModelId);
      if (cwd) {
        await codingApi.bindTaskRuntime(cwd, task.id, task.sessionId, nextModelId);
        await useTaskStore.getState().refreshTaskState();
      }
    } catch (error) {
      setModelId(previous);
      onToast?.(`切换模型失败：${String(error).replace(/^Error:\s*/, "")}`);
    }
  }, [cwd, hostSessionId, modelId, onChangeModel, onToast, task]);

  const taskChangeCount = changeSet?.changes.length ?? 0;
  const theiaDisplayPanel = task ? theiaPanel : "agent";
  const theiaPhase = task ? describePhase(task.phase) : null;
  const style = useMemo(
    () =>
      ({
        "--coding-explorer-width": `${effectiveLayout.explorerWidth}px`,
        "--coding-agent-width": `${effectiveLayout.agentWidth}px`,
        "--coding-bottom-height": `${effectiveLayout.bottomHeight}px`,
      }) as CSSProperties,
    [effectiveLayout],
  );

  const beforeTheiaMutation = useCallback(async (_operation: string, _paths: string[]) => {
    return prepareManualMutation();
  }, [prepareManualMutation]);
  const afterTheiaMutation = useCallback(async (
    ticket: TheiaMutationTicket,
    success: boolean,
    error?: string,
  ) => {
    if (success) {
      await finishManualMutation(ticket);
    } else {
      await blockInterruptedManualMutation(ticket, error ?? "Theia 文件操作失败");
    }
  }, [blockInterruptedManualMutation, finishManualMutation]);

  if (!cwd) {
    return (
      <div ref={workbenchRef} className="coding-workbench coding-workbench--empty">
        <header className="coding-workbench__topbar" data-tauri-drag-region>
          <div className="coding-workbench__topbar-left" data-tauri-drag-region>
            <button type="button" className="coding-icon-btn" onClick={exitSafely} aria-label="返回">
              <ArrowLeft size={16} />
            </button>
            <div className="coding-workbench__product" data-tauri-drag-region>
              <span className="coding-workbench__product-mark" aria-hidden="true">
                <Code2 size={14} />
              </span>
              <strong>Echo Code</strong>
            </div>
          </div>
        </header>
        <div className="coding-workbench__welcome">
          <FolderGit2 size={32} />
          <h1>打开代码库开始开发</h1>
          <p>在同一个工作台里理解代码、交给 Agent 实现、审阅变更并交付。</p>
          <button
            type="button"
            className="coding-primary-btn"
            onClick={() => void pickWorkspace()}
          >
            <FolderGit2 size={15} /> 选择代码文件夹
          </button>
          {workspaces.length > 0 && (
            <ul className="coding-workbench__recent">
              {workspaces.slice(0, 5).map((workspace) => (
                <li key={workspace.cwd}>
                  <button type="button" onClick={() => onSelectWorkspace?.(workspace.cwd)}>
                    {basename(workspace.cwd)}
                    <small>{workspace.cwd}</small>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    );
  }

  return (
    <div ref={workbenchRef} className={`coding-workbench coding-workbench--theia${theiaAgentOpen ? "" : " coding-workbench--agent-closed"}`} style={style}>
      <header className="coding-workbench__topbar" data-tauri-drag-region>
        <div className="coding-workbench__topbar-left" data-tauri-drag-region>
          <button type="button" className="coding-icon-btn" onClick={exitSafely} aria-label="返回">
            <ArrowLeft size={16} />
          </button>
          <div className="coding-workbench__product" data-tauri-drag-region>
            <span className="coding-workbench__product-mark" aria-hidden="true"><Code2 size={14} /></span>
            <strong>Echo Code</strong>
          </div>
          <span className="coding-workbench__topbar-separator" aria-hidden="true" />
          <ProjectSwitcher
            projects={recentCodingProjects}
            activeCwd={activeCodingWorkspaceCwd || cwd}
            dirtyCount={visibleDirtyCount}
            onSelect={(nextCwd) => void switchProject(nextCwd)}
            onRemove={removeRecentProject}
            onOpenFolder={openAnotherProject}
          />
        </div>
        <div className="coding-workbench__topbar-right" data-tauri-drag-region>
          <div className="echo-theia-preview" ref={theiaPreviewRef}>
            <button type="button" className="echo-theia-toolbar-button" aria-label="网页预览" aria-expanded={theiaPreviewOpen} onClick={() => setTheiaPreviewOpen((open) => !open)}>
              <PanelTop size={15} /> <span>网页预览</span>
            </button>
            {theiaPreviewOpen && (
              <form className="echo-theia-preview-form" onKeyDown={(event) => {
                if (event.key === "Escape") setTheiaPreviewOpen(false);
              }} onSubmit={(event) => {
                event.preventDefault();
                const raw = theiaPreviewInput.trim();
                if (!raw) return;
                try {
                  const url = new URL(raw.startsWith("http://") || raw.startsWith("https://") ? raw : `http://${raw}`);
                  setTheiaPreviewRequest({ url: url.toString(), id: Date.now() });
                  setTheiaPreviewOpen(false);
                } catch {
                  onToast?.("请输入有效的预览地址，例如 localhost:5173");
                }
              }}>
                <label htmlFor="echo-theia-preview-url">预览地址</label>
                <div>
                  <input id="echo-theia-preview-url" aria-label="网页预览地址" autoFocus placeholder="localhost:5173" value={theiaPreviewInput} onChange={(event) => setTheiaPreviewInput(event.target.value)} />
                  <button type="submit">打开</button>
                </div>
              </form>
            )}
          </div>
          <button type="button" className="coding-icon-btn" onClick={() => setTheiaAgentOpen((open) => !open)} aria-label={theiaAgentOpen ? "收起 Agent 面板" : "展开 Agent 面板"} aria-pressed={theiaAgentOpen}>
            {theiaAgentOpen ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
          </button>
          <button type="button" className="coding-icon-btn" onClick={onOpenSettings} aria-label="Echo 设置" title="Echo 设置：模型与 Agent">
            <Settings2 size={15} />
          </button>
        </div>
      </header>

      <main className="echo-theia-workspace">
        <TheiaIdeFrame
          ref={theiaFrameRef}
          root={cwd}
          onBeforeMutation={beforeTheiaMutation}
          onAfterMutation={afterTheiaMutation}
          onActiveFile={setTheiaActiveFile}
          onToast={onToast}
          previewRequest={theiaPreviewRequest}
          openFileRequest={theiaOpenFileRequest}
          agentVisible={theiaAgentOpen}
          onAgentBounds={setTheiaAgentBounds}
          onAgentVisibilityChange={setTheiaAgentOpen}
          onDirtyChange={setTheiaDirtyCount}
        />
        {theiaReviewPath && task && (
          <TheiaTaskReview
            root={cwd}
            taskId={task.id}
            path={theiaReviewPath}
            onClose={() => setTheiaReviewPath(null)}
            onOpenFile={() => {
              openTheiaFile(theiaReviewPath);
              setTheiaReviewPath(null);
            }}
            rightInset={theiaAgentBounds ? Math.max(0, workbenchSize.width - theiaAgentBounds.left) : 0}
            onReviewed={async () => {
              await useTaskStore.getState().refreshTaskState();
              setReportRevision((value) => value + 1);
            }}
            onToast={onToast}
          />
        )}
        {theiaReportOpen && task && (
          <section
            className="echo-theia-review echo-theia-report"
            aria-label="交付报告"
            style={{ right: theiaAgentBounds ? Math.max(0, workbenchSize.width - theiaAgentBounds.left) : 0 }}
          >
            <header className="echo-theia-review__header">
              <strong>交付报告</strong>
              <button type="button" aria-label="关闭交付报告" onClick={() => setTheiaReportOpen(false)}><X size={16} /></button>
            </header>
            <DeliveryReportTab
              root={cwd}
              taskId={task.id}
              revision={reportRevision}
              onOpenFile={(path) => {
                openTheiaFile(path);
                setTheiaReportOpen(false);
              }}
              onToast={onToast}
            />
          </section>
        )}
      <aside
        className="echo-theia-agent"
        aria-label="Coding Agent"
        aria-hidden={!theiaAgentBounds}
        style={theiaAgentBounds ? {
          left: theiaAgentBounds.left,
          top: theiaAgentBounds.top,
          width: theiaAgentBounds.width,
          height: theiaAgentBounds.height,
        } : { display: "none" }}
      >
        <div className="echo-theia-agent__heading">
          <TaskSwitcher
            tasks={summaries}
            activeId={task?.id}
            newDisabled={activeTaskCount > 0}
            onSelect={(taskId) => void activateCodingTask(taskId)}
            onNew={beginNewTask}
            onRename={renameCodingTask}
            onDelete={deleteCodingTask}
          />
          {task && theiaPhase && (
            <div className="echo-theia-agent__task-status">
              <span className={`coding-agent__phase is-${theiaPhase.tone}`}>{theiaPhase.label}</span>
              {theiaPhase.active && (
                <button type="button" className="echo-theia-agent__stop" onClick={() => void stopActiveTask()} disabled={sending || lifecycleSettling} title="停止当前任务" aria-label="停止当前任务">
                  <Square size={12} />
                </button>
              )}
            </div>
          )}
          {task && (
            <button
              type="button"
              className="echo-theia-agent__report-button"
              onClick={() => { setTheiaReviewPath(null); setTheiaReportOpen(true); }}
              aria-label="打开交付报告"
              title="查看交付检查与验收证据"
            >
              <ShieldCheck size={15} /> 报告
            </button>
          )}
        </div>
        {task && <div className="echo-theia-agent__tabs" role="tablist" aria-label="开发任务面板">
          <button type="button" role="tab" aria-selected={theiaDisplayPanel === "agent"} onClick={() => setTheiaPanel("agent")}>对话</button>
          <button type="button" role="tab" aria-selected={theiaDisplayPanel === "changes"} onClick={() => setTheiaPanel("changes")}>任务变更{taskChangeCount ? ` · ${taskChangeCount}` : ""}</button>
          <button type="button" role="tab" aria-selected={theiaDisplayPanel === "verification"} onClick={() => setTheiaPanel("verification")}>验证</button>
        </div>}
        {theiaActiveFile && (
          <div className="echo-theia-agent__context">
            <span title={theiaActiveFile}>{workspaceRelativePath(cwd, theiaActiveFile)}</span>
            <button type="button" onClick={() => addManyToContext([theiaActiveFile])}>加入上下文</button>
          </div>
        )}
        <div className="echo-theia-agent__content">
          {theiaDisplayPanel === "agent" && (task ? (
            <AgentPane
              embeddedInTheia
              task={task}
              changeSet={changeSet}
              verifications={verifications}
              sessionId={activeSessionId}
              messages={messages}
              streaming={streaming}
              phaseReason={phaseReason ?? task.phaseReason ?? undefined}
              blocker={blocker !== undefined ? blocker : task.blocker}
              awaitingPermission={awaitingPermission}
              awaitingQuestion={awaitingQuestion}
              models={models}
              modelId={modelId}
              sending={sending || lifecycleSettling}
              onModelChange={(next) => void changeTaskModel(next)}
              onSend={sendFollowup}
              onCancel={() => void stopActiveTask()}
              onContinue={continueInterruptedTask}
              onOpenChanges={() => setTheiaPanel("changes")}
              onOpenReport={() => { setTheiaReviewPath(null); setTheiaReportOpen(true); }}
              onOpenFile={openTheiaFile}
              onToast={onToast}
              onPathsDropped={(paths) => addManyToContext(paths)}
            />
          ) : (
            <div className="echo-theia-agent__empty">
              <strong>描述目标，开始开发</strong>
              <p>Agent 会理解当前项目、实施代码，并提供变更与验证结果。</p>
            </div>
          ))}
          {theiaDisplayPanel === "changes" && (
            <ChangeSetView
              changeSet={changeSet}
              hasTask={Boolean(task)}
              busyPath={busyPath}
              committing={committing}
              canCommit={task?.phase === "delivered" && !changeSet?.committedHash}
              canRollback={!changeSet?.committedHash && !runningVerification && !streaming
                && Boolean(task && ["paused", "stopped", "delivered", "blocked"].includes(task.phase))}
              canDiscard={!runningVerification && !streaming && !sending
                && Boolean(task && ["implementing", "repairing", "discovering", "paused", "stopped", "blocked", "delivered"].includes(task.phase))}
              onOpenDiff={(change) => { setTheiaReportOpen(false); setTheiaReviewPath(change.path); }}
              onDiscard={(change) => void discardChange(change.path)}
              onCommit={() => void commitChanges()}
              onRollback={() => void rollbackTask()}
            />
          )}
          {theiaDisplayPanel === "verification" && (
            <>
              <VerificationView
                records={verifications}
                detected={verificationCommands}
                running={runningVerification}
                hasTask={Boolean(task)}
                onRun={(command) => void runVerifications([command])}
                onRunAll={() => void runVerifications(verificationCommands)}
                onCancel={() => { if (activeRunId) void codingApi.cancelVerification(activeRunId); }}
                onOpenOutput={(record) => setTheiaVerificationOutput([record.stdout, record.stderr].filter(Boolean).join("\n"))}
              />
              {(runningVerification || theiaVerificationOutput || commandOutput) && (
                <div className="echo-theia-agent__output-panel" aria-label="验证命令输出">
                  <strong>{runningVerification ? "实时输出" : theiaVerificationOutput ? "历史验证输出" : "最近一次验证输出"}</strong>
                  <pre className="echo-theia-agent__output">{runningVerification
                    ? commandOutput || "正在等待命令输出…"
                    : theiaVerificationOutput || commandOutput}</pre>
                </div>
              )}
            </>
          )}
        </div>
        <TheiaAgentComposer
          key={`${cwd}:${task?.id ?? "new"}`}
          workspaceRoot={cwd}
          task={task}
          sessionId={activeSessionId}
          models={models}
          modelId={modelId}
          contextPaths={contextPaths}
          apiReady={apiReady}
          startError={startError}
          starting={starting}
          sending={sending || lifecycleSettling}
          streaming={streaming}
          onModelChange={(next) => void changeTaskModel(next)}
          onStart={startTask}
          onSend={sendFollowup}
          onRemoveContext={removeFromContext}
          onDraftContextPaths={addManyToContext}
          onOpenSettings={onOpenSettings}
          onToast={onToast}
        />
      </aside>
      </main>
      {taskDialog}
    </div>
  );
}
