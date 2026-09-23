import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import {
  ArrowLeft,
  Code2,
  FlaskConical,
  FolderGit2,
  Hammer,
  MessageSquare,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
} from "lucide-react";

import { useAppDialog } from "@/components/AppDialog";
import type { ModelOption } from "@/components/ModelSelector";
import { FileTreeView } from "@/components/workspace-panel/FileTreeView";
import { usePermissionStore } from "@/stores/permission-store";
import { useQuestionStore } from "@/stores/question-store";
import { useSessionStore } from "@/stores/session-store";
import {
  codingReadDocument,
  codingWriteDocument,
  filesystemPickDirectory,
  type CodingDocument,
  type CodingSearchHit,
  type CodingSearchOptions,
} from "@/lib/agent-client";
import { isGlobalShortcutBlocked } from "@/lib/keyboard-scope";
import { shortcutLabel } from "@/lib/platform";
import "@/styles/coding-workbench.css";
import { editor as MonacoEditor } from "monaco-editor";

import { AgentPane } from "./agent/AgentPane";
import { TaskStarter } from "./agent/TaskStarter";
import { TheiaIdeFrame, type TheiaMutationTicket } from "./TheiaIdeFrame";
import { TheiaTaskReview } from "./TheiaTaskReview";
import { ChangeSetView } from "./explorer/ChangeSetView";
import { ContextPackView } from "./explorer/ContextPackView";
import { FileExplorerView } from "./explorer/FileExplorerView";
import { SearchView } from "./explorer/SearchView";
import { SymbolView } from "./explorer/SymbolView";
import { buildCommands, type CommandContext } from "./lib/commands";
import {
  createDocumentationWorkflow,
  isDocumentationRequest,
  type DocumentationWorkflowContext,
  type EditorCodeContext,
} from "./lib/documentation";
import { applyFileIndexEvent, buildFileIndex } from "./lib/file-index";
import { codingTaskDraftKey, loadCodingHotExit, saveCodingHotExit } from "./lib/hot-exit";
import {
  buildCodingWorkflowPrompt,
  buildNodeContinuationInstruction,
  buildPlanRevisionInstruction,
  mergeTaskVerificationCommands,
} from "./lib/workflow";
import { countOccurrences, describeReplacePlan, replaceAll } from "./lib/replace";
import { isBusyPhase, statusSummary } from "./lib/phase";
import {
  codingApi,
  onPhaseChanged,
  onVerificationOutput,
  onVerificationUpdated,
  onWorkspaceFileRemoved,
  onWorkspaceFileUpdated,
} from "./lib/tauri-api";
import { getSymbolIndexClient } from "./lib/symbol-index";
import {
  type DetectedCommand,
  type IndexStatus,
  type Problem,
} from "./lib/types";
import { useTaskLifecycle } from "./lib/task-lifecycle";
import { useVerificationRunner } from "./lib/use-verification-runner";
import { FindReferencesView } from "./main/FindReferencesView";
import { GoToDefinitionView } from "./main/GoToDefinitionView";
import { ImpactAnalysisView } from "./main/ImpactAnalysisView";
import type { CodingEditorDiagnostic } from "./main/CodingEditor";
import { DeliveryReportTab } from "./main/docs/DeliveryReportTab";
import { ProjectProfileTab } from "./main/docs/ProjectProfileTab";
import { TaskDagTab } from "./main/docs/TaskDagTab";
import { BottomPanel } from "./panels/BottomPanel";
import { VerificationView } from "./panels/VerificationView";
import { TabContainer } from "./main/TabContainer";
import { FooterStatusBar } from "./FooterStatusBar";
import { ActivityBar } from "./shell/ActivityBar";
import { CommandPalette, type PaletteMode, type PaletteSymbol } from "./shell/CommandPalette";
import { ProjectSwitcher } from "./shell/ProjectSwitcher";
import { TaskSwitcher } from "./shell/TaskSwitcher";
import {
  DEFAULT_MINIMAP_ENABLED,
  completeFileTabLoad,
  isDirty,
  isFileTab,
  useTabStore,
  type FileTab,
  type SymbolKey,
  type WorkspaceUiState,
} from "./store/tab-store";
import { useTaskStore } from "./store/task-store";
import { useFileTreeSelectionStore } from "./store/file-tree-selection-store";
import { useClipboardStore } from "./store/clipboard-store";
import { useGitSnapshotStore } from "./store/git-snapshot-store";
import { humanOpLabel, useHistoryStackStore } from "./store/history-stack-store";
import {
  buildRefactorPrompt,
  buildReviewPrompt,
  buildTestsPrompt,
  type DocumentSnippet,
} from "@/features/coding/lib/ai-prompts";
import { FileTreeContextMenu, type ContextMenuItem } from "@/components/workspace-panel/FileTreeContextMenu";
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
  onAddCodingWorkspace?: () => void;
  onToast?: (message: string) => void;
  onExit?: () => void;
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

interface OpenTaskDiffOptions {
  /** Opening from the UI counts as review; background refreshes do not. */
  notifyError?: boolean;
  refreshTaskState?: boolean;
  showLoading?: boolean;
  activate?: boolean;
}

interface OpenTaskDiffResult {
  status: "opened" | "missing" | "error" | "cancelled";
  message?: string;
}

const FILE_OPEN_TIMEOUT_MS = 15_000;

/** A filesystem request must never leave the editor behind an endless spinner. */
async function readDocumentWithTimeout(root: string, path: string): Promise<CodingDocument> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      codingReadDocument(root, path),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error("读取文件超时，请重试")),
          FILE_OPEN_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
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

function matchingOpenFileTab(relativePath: string) {
  const normalized = normalizedRelativePath(relativePath);
  return useTabStore.getState().tabs.find(
    (entry) => isFileTab(entry) && normalizedRelativePath(entry.relativePath) === normalized,
  );
}

/** Reconcile one open tab without ever replacing an unsaved editor draft. */
async function reconcileOpenFileTab(
  root: string,
  relativePath: string,
  removed = false,
): Promise<void> {
  const before = matchingOpenFileTab(relativePath);
  if (!before || !isFileTab(before)) return;

  if (removed) {
    if (before.draft !== before.original) {
      useTabStore.getState().markConflict(before.id);
    } else if (before.view === "diff" && before.diffModified !== undefined) {
      // Keep an already loaded deletion diff visible. The watcher refresh below
      // replaces it from the task baseline instead of flashing an error state.
      return;
    } else {
      useTabStore.getState().setError(before.id, "文件已被 Agent 或其他程序删除");
    }
    return;
  }

  try {
    const document = await codingReadDocument(root, before.id);
    const current = useTabStore.getState().tabs.find((entry) => entry.id === before.id);
    if (!current || !isFileTab(current) || current.hash === document.hash) return;
    if (current.draft !== current.original) {
      useTabStore.getState().markConflict(current.id);
    } else {
      useTabStore.getState().markSaved(current.id, document.content, document.hash);
    }
  } catch {
    const current = useTabStore.getState().tabs.find((entry) => entry.id === before.id);
    if (!current || !isFileTab(current)) return;
    if (current.draft !== current.original) {
      useTabStore.getState().markConflict(current.id);
    } else {
      useTabStore.getState().setError(current.id, "文件已被删除或暂时无法读取");
    }
  }
}

const EXPLORER_TITLES: Record<string, string> = {
  files: "资源管理器",
  search: "搜索",
  changes: "任务变更",
  symbols: "工作区符号",
  context: "上下文包",
};

/** Resolve a workspace-relative path against the repository root. */
function workspaceFilePath(root: string, path: string): string {
  if (/^(?:[a-z]:[\\/]|[\\/]{2}|\/)/i.test(path)) return path;
  return `${root.replace(/[\\/]+$/, "")}/${path.replace(/^[\\/]+/, "")}`;
}

/**
 * Pointer-drag handler shared by both vertical separators. Delta-based sizing
 * stays correct when the workbench is nested or the window moves displays.
 */
function useDragWidth(
  currentWidth: number,
  apply: (value: number) => void,
  fromRight: boolean,
) {
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => () => cleanupRef.current?.(), []);

  return useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      cleanupRef.current?.();
      const startX = event.clientX;
      const startWidth = currentWidth;
      const previousCursor = document.body.style.cursor;
      const previousUserSelect = document.body.style.userSelect;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      const move = (moveEvent: PointerEvent) => {
        const delta = moveEvent.clientX - startX;
        apply(startWidth + (fromRight ? -delta : delta));
      };
      const stop = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", stop);
        window.removeEventListener("pointercancel", stop);
        document.body.style.cursor = previousCursor;
        document.body.style.userSelect = previousUserSelect;
        cleanupRef.current = null;
      };
      cleanupRef.current = stop;
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", stop);
      window.addEventListener("pointercancel", stop);
    },
    [apply, currentWidth, fromRight],
  );
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
  onOpenSettings,
  models = [],
  codingWorkspaces,
  activeCodingWorkspaceCwd,
  onCloseCodingWorkspace,
  onAddCodingWorkspace,
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
  const bottomOpen = useWorkbenchStore((state) => state.bottomOpen);
  const bottomView = useWorkbenchStore((state) => state.bottomView);
  const setBottomHeight = useWorkbenchStore((state) => state.setBottomHeight);
  const setExplorerWidth = useWorkbenchStore((state) => state.setExplorerWidth);
  const setAgentWidth = useWorkbenchStore((state) => state.setAgentWidth);
  const hydrateLayout = useWorkbenchStore((state) => state.hydrateLayout);

  const activityView = useWorkbenchStore((state) => state.activityView);
  const setActivityView = useWorkbenchStore((state) => state.setActivityView);
  const setBottomView = useWorkbenchStore((state) => state.setBottomView);
  const toggleBottom = useWorkbenchStore((state) => state.toggleBottom);
  const showHidden = useWorkbenchStore((state) => state.showHidden);
  const setShowHidden = useWorkbenchStore((state) => state.setShowHidden);
  const gitStatusByPath = useGitSnapshotStore((state) => state.byPath);

  const tabs = useTabStore((state) => state.tabs);
  const activeTabId = useTabStore((state) => state.activeId);
  const dirtyFileCount = useMemo(() => tabs.filter(isDirty).length, [tabs]);
  const recentCodingProjects = useMemo(() => {
    const paths = [
      activeCodingWorkspaceCwd || cwd,
      ...(codingWorkspaces ?? []).map((workspace) => workspace.cwd),
    ].filter(Boolean);
    return [...new Set(paths)].map((projectCwd) => ({ cwd: projectCwd }));
  }, [activeCodingWorkspaceCwd, codingWorkspaces, cwd]);

  const [selectedDirectory, setSelectedDirectory] = useState(cwd);
  const [theiaPanel, setTheiaPanel] = useState<"agent" | "changes" | "verification">("agent");
  const [theiaActiveFile, setTheiaActiveFile] = useState<string | null>(null);
  const [theiaReviewPath, setTheiaReviewPath] = useState<string | null>(null);
  const [theiaPreviewInput, setTheiaPreviewInput] = useState("");
  const [theiaPreviewRequest, setTheiaPreviewRequest] = useState<{ url: string; id: number } | null>(null);
  const [theiaVerificationOutput, setTheiaVerificationOutput] = useState("");
  const [paletteMode, setPaletteMode] = useState<PaletteMode | null>(null);
  const [filePaths, setFilePaths] = useState<string[]>([]);
  const [indexing, setIndexing] = useState(false);
  const [symbolsByPath, setSymbolsByPath] = useState<Record<string, PaletteSymbol[]>>({});
  const [workspaceSymbols, setWorkspaceSymbols] = useState<PaletteSymbol[]>([]);
  const [editorContext, setEditorContext] = useState<EditorCodeContext | null>(null);
  const [reveal, setReveal] = useState<{ line: number; column: number; key: number }>();
  // SP1: context menu + inline rename state.
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    primaryPath: string;
    primaryKind: "file" | "directory";
    selectedPaths: string[];
    pasteTargetDir: string;
  } | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const cutPaths = useClipboardStore((state) =>
    state.mode === "cut" ? new Set(state.paths) : undefined,
  );
  const [indexStatus, setIndexStatus] = useState<IndexStatus | null>(null);
  const indexReady = indexStatus?.state === "ready";
  const [contextPaths, setContextPaths] = useState<string[]>([]);
  const [editorDiagnostics, setEditorDiagnostics] = useState<Record<string, CodingEditorDiagnostic[]>>({});
  const [reviewingPath, setReviewingPath] = useState<string | null>(null);
  const [replacing, setReplacing] = useState(false);
  const [modelId, setModelId] = useState(defaultModelId);
  const [startError, setStartError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [sending, setSending] = useState(false);
  const [phaseReason, setPhaseReason] = useState<string>();
  const [blocker, setBlocker] = useState<string | null | undefined>(undefined);
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [diffLoadingPath, setDiffLoadingPath] = useState<string | null>(null);
  const [committing, setCommitting] = useState(false);
  const [detected, setDetected] = useState<DetectedCommand[]>([]);
  const [detectedReady, setDetectedReady] = useState(false);
  const [commandOutput, setCommandOutput] = useState("");
  const [terminalActivated, setTerminalActivated] = useState(false);
  const [treeRefresh, setTreeRefresh] = useState<{ revision: number; paths: string[] }>({
    revision: 0,
    paths: [],
  });
  const [treeCollapseKey, setTreeCollapseKey] = useState(0);
  const [treePersistenceRevision, setTreePersistenceRevision] = useState(0);
  const [treeReveal, setTreeReveal] = useState<{ path?: string; key: number }>({ key: 0 });
  /** Filename substring filter shared by the explorer input and the file tree. */
  const [explorerFilter, setExplorerFilter] = useState("");
  /** Bumped whenever the task's evidence changes, so an open report reloads. */
  const [reportRevision, setReportRevision] = useState(0);
  /** Bumped when any per-workspace UI state (minimap mode, ...) mutates so React re-reads the ref. */
  const [uiStateRevision, setUiStateRevision] = useState(0);
  // Read once so the type-checker keeps the variable alive (the value is not
  // used directly—bumping the revision is what triggers the re-render).
  void uiStateRevision;
  /** Latest cursor position from the active editor; rendered in the footer status bar. */
  const [cursor, setCursor] = useState<{ line: number; column: number } | null>(null);
  /** Detected line ending of the active document (`null` until first read). */
  const [eol, setEol] = useState<"LF" | "CRLF" | null>(null);
  /** Monaco language id of the active document (`null` until first read). */
  const [languageId, setLanguageId] = useState<string | null>(null);
  /** Indentation options from the active Monaco model. */
  const [indent, setIndent] = useState<{ kind: "space" | "tab"; size: number }>({ kind: "space", size: 2 });
  /** Live Monaco editor handle so the footer can apply EOL / indent changes directly to the model. */
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const repairPromptRef = useRef<string | null>(null);
  const workflowActionRef = useRef<string | null>(null);
  const pendingTreePathsRef = useRef(new Set<string>());
  const treeRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileIndexEventsRef = useRef(new Map<string, boolean>());
  const diffRequestGenerationRef = useRef(new Map<string, number>());
  const fileReadGenerationRef = useRef(new Map<string, number>());
  const diffTaskRef = useRef<string | null>(null);
  const contextSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const workbenchMountedRef = useRef(true);
  const previousWorkspaceRef = useRef("");
  const workspaceUiStateRef = useRef(new Map<string, WorkspaceUiState>());
  const treeExpandedPathsRef = useRef(new Map<string, string[]>());
  const workbenchRef = useRef<HTMLDivElement>(null);
  const workbenchSize = useElementSize(workbenchRef);

  useEffect(() => {
    workbenchMountedRef.current = true;
    return () => {
      workbenchMountedRef.current = false;
    };
  }, []);

  const queueTreeRefresh = useCallback((changedPath: string) => {
    const relativePath = workspaceRelativePath(cwd, changedPath);
    pendingTreePathsRef.current.add(relativePath);
    if (treeRefreshTimerRef.current !== null) return;
    treeRefreshTimerRef.current = setTimeout(() => {
      treeRefreshTimerRef.current = null;
      const paths = [...pendingTreePathsRef.current];
      pendingTreePathsRef.current.clear();
      setTreeRefresh((current) => ({ revision: current.revision + 1, paths }));
      // SP2: re-fetch git snapshot alongside the tree refresh so badges stay
      // current whenever the file system changes.
      void useGitSnapshotStore.getState().refresh(cwd);
    }, 80);
  }, [cwd]);

  const queueTreeRefreshPaths = useCallback((changedPaths: string[]) => {
    if (changedPaths.length === 0) return;
    const relativePaths = changedPaths
      .map((p) => workspaceRelativePath(cwd, p))
      .filter((p): p is string => Boolean(p));
    if (relativePaths.length === 0) return;
    pendingTreePathsRef.current.clear();
    setTreeRefresh((current) => ({
      revision: current.revision + 1,
      paths: relativePaths,
    }));
  }, [cwd]);

  const recordFileIndexEvent = useCallback((changedPath: string, removed: boolean) => {
    const relativePath = workspaceRelativePath(cwd, changedPath);
    if (!relativePath) return;
    fileIndexEventsRef.current.set(relativePath, removed);
    setFilePaths((current) => applyFileIndexEvent(current, relativePath, removed));
  }, [cwd]);

  const reconcileFileIndexEvents = useCallback((paths: string[]) => {
    let next = paths;
    for (const [path, removed] of fileIndexEventsRef.current) {
      next = applyFileIndexEvent(next, path, removed);
    }
    return next;
  }, []);

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
  const combinedProblems = useMemo<Problem[]>(() => {
    const editorProblems = Object.entries(editorDiagnostics).flatMap(([path, diagnostics]) =>
      diagnostics.map((diagnostic) => ({
        id: `editor:${path}:${diagnostic.line}:${diagnostic.column}:${diagnostic.message}`,
        kind: diagnostic.severity === "error" ? "syntax" as const : "lint" as const,
        severity: diagnostic.severity,
        message: diagnostic.message,
        file: workspaceRelativePath(cwd, diagnostic.path || path),
        line: diagnostic.line,
        column: diagnostic.column,
        sourceCommand: "Monaco",
        fingerprint: `editor:${path}:${diagnostic.line}:${diagnostic.column}:${diagnostic.message}`,
      })),
    );
    const seen = new Set(problems.map((problem) => problem.fingerprint));
    return [...problems, ...editorProblems.filter((problem) => !seen.has(problem.fingerprint))];
  }, [cwd, editorDiagnostics, problems]);
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

  // A diff is anchored to one task's baseline. Never let a cached comparison
  // from the previous task leak into a newly selected task.
  useEffect(() => {
    const taskId = task?.id ?? null;
    if (diffTaskRef.current === taskId) return;
    diffTaskRef.current = taskId;
    diffRequestGenerationRef.current.clear();
    setDiffLoadingPath(null);
    for (const tab of useTabStore.getState().tabs) {
      if (isFileTab(tab) && tab.diffOriginal !== undefined) {
        useTabStore.getState().clearDiff(tab.id);
      }
    }
  }, [task?.id]);

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

  useEffect(() => {
    const openPaths = new Set(tabs.filter(isFileTab).map((tab) => tab.id));
    setEditorDiagnostics((current) => Object.fromEntries(
      Object.entries(current).filter(([path]) => openPaths.has(path)),
    ));
  }, [tabs]);

  // SP2: refresh git snapshot on workspace switch so badges appear as soon
  // as a user lands on a new repo. Debounced inside the store.
  useEffect(() => {
    if (cwd) void useGitSnapshotStore.getState().refresh(cwd);
    else useGitSnapshotStore.getState().clear();
  }, [cwd]);

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

  const activeFileTab = useMemo(() => {
    const found = tabs.find((tab) => tab.id === activeTabId);
    return found && isFileTab(found) ? found : null;
  }, [activeTabId, tabs]);

  useEffect(() => {
    editorRef.current = null;
    setCursor(null);
    setEol(null);
    setLanguageId(null);
    setIndent({ kind: "space", size: 2 });
  }, [activeFileTab?.id, activeFileTab?.view]);

  const symbols = activeFileTab ? (symbolsByPath[activeFileTab.id] ?? []) : [];
  const activeRelativePath = activeFileTab?.relativePath;

  /**
   * Convert transient Monaco state into an evidence-backed documentation
   * request. Index/impact failures deliberately degrade to source discovery by
   * the Agent; an approximate graph must never block a useful /doc action.
   */
  const resolveDocumentationWorkflow = useCallback(async (
    instruction: string,
    override?: EditorCodeContext,
  ): Promise<DocumentationWorkflowContext> => {
    const matchingOverride = override
      && activeRelativePath
      && normalizedRelativePath(override.path) === normalizedRelativePath(activeRelativePath)
      ? override
      : undefined;
    const matchingContext = editorContext
      && activeRelativePath
      && normalizedRelativePath(editorContext.path) === normalizedRelativePath(activeRelativePath)
      ? editorContext
      : undefined;
    const target = matchingOverride ?? matchingContext ?? (activeFileTab
      ? {
          path: activeFileTab.relativePath,
          language: activeFileTab.language,
          cursorLine: 1,
          cursorColumn: 1,
          startLine: 1,
          startColumn: 1,
          endLine: 1,
          endColumn: 1,
          selectedText: "",
          selectionTruncated: false,
        }
      : undefined);
    const relativePath = target?.path
      ? workspaceRelativePath(cwd, target.path)
      : undefined;

    let symbol = null;
    if (cwd && relativePath && target) {
      try {
        const evidenceLine = target.selectedText.trim() ? target.startLine : target.cursorLine;
        symbol = await codingApi.symbolAt(cwd, relativePath, evidenceLine);
      } catch {
        // The editor outline below is still useful when the workspace index is
        // building or the current language is not supported by the backend.
      }
    }

    const symbolName = symbol?.name ?? target?.symbol?.name;
    let impact = null;
    if (cwd && symbolName && indexReady) {
      try {
        impact = await codingApi.impactAnalyze(cwd, symbolName, 3, true);
      } catch {
        // Approximate impact is an optimization, never an authority or blocker.
      }
    }

    return createDocumentationWorkflow(instruction, target
      ? { ...target, path: relativePath ?? target.path }
      : undefined, {
      symbol,
      impact,
      indexReady,
    });
  }, [activeFileTab, activeRelativePath, cwd, editorContext, indexReady]);

  /**
   * Read a file into its tab. A failed or interrupted tab is deliberately
   * retried instead of merely being focused, and only the newest request may
   * settle it. This prevents workspace switches and late responses from
   * restoring a permanently loading tab.
   */
  const loadFile = useCallback(
    async (absolutePath: string, force = false, notifySuccess = false) => {
      const requestRoot = cwd;
      if (!requestRoot) return;

      const store = useTabStore.getState();
      const existing = store.tabs.find((tab) => tab.id === absolutePath);
      if (existing) {
        store.setActive(absolutePath);
        if (!isFileTab(existing) || (!force && !existing.loading && !existing.error)) return;
        store.beginFileLoad(absolutePath);
      } else {
        store.openFile({
          id: absolutePath,
          relativePath: workspaceRelativePath(requestRoot, absolutePath),
          name: basename(absolutePath),
          language: "plaintext",
          original: "",
          draft: "",
          hash: "",
          loading: true,
        });
      }

      const requestKey = `${requestRoot}\0${absolutePath}`;
      const generation = (fileReadGenerationRef.current.get(requestKey) ?? 0) + 1;
      fileReadGenerationRef.current.set(requestKey, generation);

      const settleActiveOrCachedTab = (
        updateActive: (id: string) => void,
        updateCached: (tab: FileTab) => FileTab,
      ): boolean => {
        if (
          !workbenchMountedRef.current
          || fileReadGenerationRef.current.get(requestKey) !== generation
        ) {
          return false;
        }

        if (previousWorkspaceRef.current === requestRoot) {
          const current = useTabStore.getState();
          const tab = current.tabs.find((entry) => entry.id === absolutePath);
          if (!tab || !isFileTab(tab)) return false;
          updateActive(absolutePath);
          return true;
        }

        const cached = workspaceUiStateRef.current.get(requestRoot);
        if (!cached) return false;
        let found = false;
        const tabs = cached.tabs.map((entry) => {
          if (entry.id !== absolutePath || !isFileTab(entry)) return entry;
          found = true;
          return updateCached(entry);
        });
        if (found) workspaceUiStateRef.current.set(requestRoot, { ...cached, tabs });
        return found;
      };

      try {
        const document = await readDocumentWithTimeout(requestRoot, absolutePath);
        const snapshot = {
          relativePath: document.relativePath,
          language: document.language,
          original: document.content,
          draft: document.content,
          hash: document.hash,
        };
        const settled = settleActiveOrCachedTab(
          (id) => useTabStore.getState().completeFileLoad(id, snapshot),
          (tab) => completeFileTabLoad(tab, snapshot),
        );
        if (settled && notifySuccess && previousWorkspaceRef.current === requestRoot) {
          onToast?.(`已重新加载 ${basename(absolutePath)}`);
        }
      } catch (error) {
        const message = String(error).replace(/^Error:\s*/, "");
        const errorMessage = `打开失败：${message}`;
        const settled = settleActiveOrCachedTab(
          (id) => useTabStore.getState().setError(id, errorMessage),
          (tab) => ({ ...tab, loading: false, error: errorMessage }),
        );
        if (settled && previousWorkspaceRef.current === requestRoot) {
          onToast?.(`无法打开 ${basename(absolutePath)}：${message}`);
        }
      }
    },
    [cwd, onToast],
  );

  /** Load a file into a tab, reusing healthy tabs and retrying broken ones. */
  const openFile = useCallback(
    (absolutePath: string) => loadFile(absolutePath),
    [loadFile],
  );

  /** Open the Find References virtual tab for a symbol. */
  const openFindReferences = useCallback(
    (symbol: SymbolKey) => {
      if (!cwd) return;
      if (!symbol.name) {
        setPaletteMode("symbols");
        return;
      }
      useTabStore.getState().openVirtual("findReferences", cwd, symbol);
    },
    [cwd],
  );

  /** Open the Impact Analysis virtual tab for a symbol. */
  const openImpactAnalysis = useCallback(
    (symbol: SymbolKey) => {
      if (!cwd) return;
      if (!symbol.name) {
        setPaletteMode("symbols");
        return;
      }
      useTabStore.getState().openVirtual("impactAnalysis", cwd, symbol);
    },
    [cwd],
  );

  /** Open the Go-To-Definition virtual tab for a symbol. */
  const openGoToDefinition = useCallback(
    (symbol: SymbolKey) => {
      if (!cwd) return;
      if (!symbol.name) {
        setPaletteMode("symbols");
        return;
      }
      useTabStore.getState().openVirtual("goToDefinition", cwd, symbol);
    },
    [cwd],
  );

  /** Trigger a full rebuild of the workspace symbol index. */
  const rebuildIndex = useCallback(async () => {
    if (!cwd) return;
    try {
      const next = await codingApi.indexRebuild(cwd);
      setIndexStatus(next);
      void getSymbolIndexClient(cwd).refresh();
    } catch (error) {
      onToast?.(`重建索引失败：${String(error).replace(/^Error:\s*/, "")}`);
    }
  }, [cwd, onToast]);

  /** Jump to a (file, line) and reveal it in the editor. */
  const jumpToSymbol = useCallback(
    (target: { path: string; line: number; name?: string }) => {
      void openFile(workspaceFilePath(cwd, target.path));
      setReveal({ line: target.line, column: 1, key: Date.now() });
    },
    [cwd, openFile],
  );

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

  /**
   * Save a tab. The backend compares the hash we loaded against what is on disk
   * and refuses the write when they differ, which is how a concurrent Agent edit
   * is caught instead of silently overwritten.
   */
  const saveFile = useCallback(
    async (id: string) => {
      const tab = useTabStore.getState().tabs.find((entry) => entry.id === id);
      if (!tab || !isFileTab(tab)) return;
      const mutation = await prepareManualMutation();
      if (!mutation) return;
      let fileWritten = false;
      try {
        const saved = await codingWriteDocument(cwd, id, tab.draft, tab.hash);
        fileWritten = true;
        useTabStore.getState().markSaved(id, saved.content, saved.hash);
        await finishManualMutation(mutation);
        onToast?.(`已保存 ${tab.name}`);
      } catch (error) {
        const message = String(error).replace(/^Error:\s*/, "");
        await blockInterruptedManualMutation(
          mutation,
          fileWritten ? `文件已保存，但任务变更同步失败：${message}` : `手动编辑未能完成：${message}`,
        );
        if (message.includes("保存冲突")) {
          useTabStore.getState().markConflict(id);
          onToast?.(message);
          return;
        }
        onToast?.(fileWritten ? `文件已保存，但任务同步失败：${message}` : `保存失败：${message}`);
      }
    },
    [blockInterruptedManualMutation, cwd, finishManualMutation, onToast, prepareManualMutation],
  );

  const reloadFile = useCallback(
    (id: string) => loadFile(id, true, true),
    [loadFile],
  );

  const closeTabSafely = useCallback(async (id: string) => {
    const tab = useTabStore.getState().tabs.find((entry) => entry.id === id);
    if (tab && isFileTab(tab) && tab.draft !== tab.original) {
      const confirmed = await confirmTaskAction({
        title: `关闭未保存的文件“${tab.name}”？`,
        description: "未保存的编辑内容将被放弃，磁盘文件不会改变。",
        confirmLabel: "放弃并关闭",
        danger: true,
      });
      if (!confirmed) return;
    }
    useTabStore.getState().closeTab(id);
  }, [confirmTaskAction]);

  const persistHotExitNow = useCallback(() => {
    if (!cwd) return;
    const tabState = useTabStore.getState();
    saveCodingHotExit({
      version: 1,
      root: cwd,
      tabs: tabState.tabs,
      activeId: tabState.activeId,
      selectedDirectory,
      expandedPaths: treeExpandedPathsRef.current.get(cwd) ?? [],
      minimapEnabled: workspaceUiStateRef.current.get(cwd)?.minimapEnabled ?? DEFAULT_MINIMAP_ENABLED,
      savedAt: Date.now(),
    });
  }, [cwd, selectedDirectory]);

  const exitSafely = useCallback(async () => {
    const dirtyCount = useTabStore.getState().tabs.filter(
      (tab) => isFileTab(tab) && tab.draft !== tab.original,
    ).length;
    if (dirtyCount > 0) {
      const confirmed = await confirmTaskAction({
        title: "离开代码开发？",
        description: `有 ${dirtyCount} 个文件尚未保存。草稿会保留在本机，但建议先保存需要写入工程的内容。`,
        confirmLabel: "保留草稿并离开",
      });
      if (!confirmed) return;
    }
    persistHotExitNow();
    onExit?.();
  }, [confirmTaskAction, onExit, persistHotExitNow]);

  const switchProject = useCallback((nextCwd: string) => {
    if (!nextCwd || nextCwd === cwd) return;
    if (activeTaskCount > 0) {
      onToast?.(
        activeTaskCount === 1
          ? "当前开发任务仍在执行，请先停止任务再切换项目"
          : `当前项目有 ${activeTaskCount} 个任务仍在执行，请先停止后再切换项目`,
      );
      return;
    }
    if (dirtyFileCount > 0) {
      onToast?.(`当前项目的 ${dirtyFileCount} 个未保存文件已保留，返回后可继续编辑`);
    }
    onSelectWorkspace?.(nextCwd);
  }, [activeTaskCount, cwd, dirtyFileCount, onSelectWorkspace, onToast]);

  const removeRecentProject = useCallback(async (projectCwd: string) => {
    if (projectCwd === cwd && activeTaskCount > 0) {
      onToast?.("当前开发任务仍在执行，请先停止任务再移除项目");
      return;
    }
    if (projectCwd === cwd && dirtyFileCount > 0) {
      const confirmed = await confirmTaskAction({
        title: "从最近项目移除？",
        description: `当前项目有 ${dirtyFileCount} 个未保存文件。草稿会保留在本机，磁盘文件不会被删除。`,
        confirmLabel: "从列表移除",
        danger: true,
      });
      if (!confirmed) return;
    }
    onCloseCodingWorkspace?.(projectCwd);
  }, [activeTaskCount, confirmTaskAction, cwd, dirtyFileCount, onCloseCodingWorkspace, onToast]);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      persistHotExitNow();
      const dirty = useTabStore.getState().tabs.some(
        (tab) => isFileTab(tab) && tab.draft !== tab.original,
      );
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [persistHotExitNow]);

  const openTaskDiff = useCallback(async (
    path: string,
    options: OpenTaskDiffOptions = {},
  ): Promise<OpenTaskDiffResult> => {
    const activeTask = useTaskStore.getState().task;
    if (!cwd || !activeTask) {
      return { status: "missing", message: "当前没有开发任务" };
    }

    const relativePath = workspaceRelativePath(cwd, path);
    const absolutePath = workspaceFilePath(cwd, relativePath);
    const generation = (diffRequestGenerationRef.current.get(absolutePath) ?? 0) + 1;
    diffRequestGenerationRef.current.set(absolutePath, generation);
    const isCurrent = () => (
      diffRequestGenerationRef.current.get(absolutePath) === generation
      && useTaskStore.getState().task?.id === activeTask.id
    );
    const showLoading = options.showLoading ?? true;
    if (showLoading) setDiffLoadingPath(relativePath);

    try {
      // The command synchronizes the native ChangeSet before reading, so every
      // toolbar click is a real refresh rather than a switch to cached panes.
      const diff = await codingApi.changeDiff(cwd, activeTask.id, relativePath);
      if (!isCurrent()) return { status: "cancelled" };

      // Bring the editor's disk snapshot forward before installing the task
      // diff. This prevents a later task-state refresh from clearing or hiding
      // the comparison that was just opened.
      await reconcileOpenFileTab(cwd, relativePath);
      if (!isCurrent()) return { status: "cancelled" };

      const existing = matchingOpenFileTab(relativePath);
      if ((options.activate ?? true) || !existing) {
        await openFile(absolutePath);
      }
      if (!isCurrent()) return { status: "cancelled" };

      useTabStore.getState().setDiff(
        absolutePath,
        diff.original,
        diff.modified,
        diff.binary,
        activeTask.id,
      );

      if (options.refreshTaskState ?? true) {
        await useTaskStore.getState().refreshTaskState();
        setReportRevision((value) => value + 1);
      }
      if (!isCurrent()) return { status: "cancelled" };

      // A reconciliation triggered by the task refresh may have touched the
      // same tab. Re-apply the exact snapshot returned for this request last.
      useTabStore.getState().setDiff(
        absolutePath,
        diff.original,
        diff.modified,
        diff.binary,
        activeTask.id,
      );
      if (diff.binary && (options.notifyError ?? true)) {
        onToast?.("二进制文件无法显示文本差异，已显示文件状态摘要");
      }
      return { status: "opened" };
    } catch (error) {
      const message = String(error).replace(/^Error:\s*/, "");
      const status = message.includes("不在当前任务变更集") ? "missing" : "error";
      if ((options.notifyError ?? true) && isCurrent()) {
        onToast?.(`打开任务差异失败：${message}`);
      }
      return { status, message };
    } finally {
      if (diffRequestGenerationRef.current.get(absolutePath) === generation) {
        setDiffLoadingPath((current) => current === relativePath ? null : current);
      }
    }
  }, [cwd, onToast, openFile]);

  const handleFileViewChange = useCallback(async (
    id: string,
    view: "edit" | "diff",
  ) => {
    const tab = useTabStore.getState().tabs.find((entry) => entry.id === id);
    if (!tab || !isFileTab(tab)) return;
    const relativePath = workspaceRelativePath(cwd, tab.relativePath || id);

    if (view === "edit") {
      // Invalidate a pending request so it cannot pull the user back into diff
      // after they deliberately returned to the editor.
      diffRequestGenerationRef.current.set(
        id,
        (diffRequestGenerationRef.current.get(id) ?? 0) + 1,
      );
      setDiffLoadingPath((current) => current === relativePath ? null : current);
      useTabStore.getState().setView(id, "edit");
      return;
    }

    const result = await openTaskDiff(relativePath, { notifyError: false });
    if (result.status === "opened" || result.status === "cancelled") return;

    const current = useTabStore.getState().tabs.find((entry) => entry.id === id);
    if (!current || !isFileTab(current)) return;
    useTabStore.getState().clearDiff(id);
    if (current.draft !== current.original) {
      useTabStore.getState().setView(id, "diff");
      onToast?.(result.status === "missing"
        ? "当前文件没有任务变更，已显示未保存的本地修改"
        : `任务差异暂时无法刷新，已显示未保存的本地修改：${result.message ?? "未知错误"}`);
      return;
    }
    onToast?.(result.status === "missing"
      ? "当前文件不在当前任务变更中，也没有未保存修改"
      : `打开任务差异失败：${result.message ?? "未知错误"}`);
  }, [cwd, onToast, openTaskDiff]);

  const markTaskDiffReviewed = useCallback(async (tab: FileTab) => {
    if (!cwd || !task || tab.diffTaskId !== task.id) return;
    const relativePath = workspaceRelativePath(cwd, tab.relativePath);
    setReviewingPath(relativePath);
    try {
      await codingApi.markReviewed(cwd, task.id, relativePath);
      await useTaskStore.getState().refreshTaskState();
      setReportRevision((value) => value + 1);
      onToast?.(`已标记 ${relativePath} 为已审阅`);
    } catch (error) {
      onToast?.(`标记已审阅失败：${String(error).replace(/^Error:\s*/, "")}`);
    } finally {
      setReviewingPath(null);
    }
  }, [cwd, onToast, task]);

  const refreshVisibleDiff = useCallback(async (relativePath: string): Promise<boolean> => {
    const tab = matchingOpenFileTab(relativePath);
    if (!tab || !isFileTab(tab) || tab.view !== "diff") return false;
    const result = await openTaskDiff(relativePath, {
      activate: false,
      notifyError: false,
      refreshTaskState: false,
      showLoading: false,
    });
    if (result.status !== "missing") return true;

    // The file may have been reverted and removed from the synchronized task
    // ChangeSet. Never leave the previous task diff masquerading as current.
    const current = matchingOpenFileTab(relativePath);
    if (!current || !isFileTab(current)) return true;
    useTabStore.getState().clearDiff(current.id);
    if (current.draft !== current.original) {
      useTabStore.getState().setView(current.id, "diff");
    }
    return true;
  }, [openTaskDiff]);

  // Keep clean editor tabs live for every workspace file type. If the user is
  // reviewing a diff, refresh the task-baseline comparison after the disk
  // snapshot is reconciled instead of silently falling back to identical panes.
  useEffect(() => {
    pendingTreePathsRef.current.clear();
    fileIndexEventsRef.current.clear();
    if (treeRefreshTimerRef.current !== null) {
      clearTimeout(treeRefreshTimerRef.current);
      treeRefreshTimerRef.current = null;
    }
    return () => {
      pendingTreePathsRef.current.clear();
      if (treeRefreshTimerRef.current !== null) {
        clearTimeout(treeRefreshTimerRef.current);
        treeRefreshTimerRef.current = null;
      }
    };
  }, [cwd]);

  useEffect(() => {
    if (!cwd) return;
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    void onWorkspaceFileUpdated((event) => {
      if (disposed || event.root !== cwd) return;
      queueTreeRefresh(event.file);
      recordFileIndexEvent(event.file, false);
      void (async () => {
        await reconcileOpenFileTab(cwd, event.file);
        const refreshed = !disposed && await refreshVisibleDiff(event.file);
        if (refreshed && !disposed) await useTaskStore.getState().refreshTaskState();
      })();
    }).then((unlisten) => {
      if (disposed) unlisten();
      else unlisteners.push(unlisten);
    });
    void onWorkspaceFileRemoved((event) => {
      if (disposed || event.root !== cwd) return;
      queueTreeRefresh(event.file);
      recordFileIndexEvent(event.file, true);
      void (async () => {
        await reconcileOpenFileTab(cwd, event.file, true);
        const refreshed = !disposed && await refreshVisibleDiff(event.file);
        if (refreshed && !disposed) await useTaskStore.getState().refreshTaskState();
      })();
    }).then((unlisten) => {
      if (disposed) unlisten();
      else unlisteners.push(unlisten);
    });
    return () => {
      disposed = true;
      for (const unlisten of unlisteners) unlisten();
    };
  }, [cwd, queueTreeRefresh, recordFileIndexEvent, refreshVisibleDiff]);

  // File-system notifications can race watcher startup. A synchronized
  // ChangeSet is the fallback, and open diff tabs are refreshed from it too.
  useEffect(() => {
    if (!cwd || !changeSet || (task && changeSet.taskId !== task.id)) return;
    let disposed = false;
    void (async () => {
      for (const change of changeSet.changes) {
        if (disposed) return;
        await reconcileOpenFileTab(cwd, change.path, change.kind === "deleted");
        if (!disposed) await refreshVisibleDiff(change.path);
      }
    })();
    return () => {
      disposed = true;
    };
  }, [changeSet, cwd, refreshVisibleDiff, task?.id]);

  /**
   * Replace across the files a search matched.
   *
   * This edits files the user has not necessarily opened, so it always confirms
   * first and reports how many files a hash conflict caused it to skip rather
   * than reporting a clean success.
   */
  const replaceAcrossHits = useCallback(
    async (
      query: string,
      replacement: string,
      hits: CodingSearchHit[],
      options: CodingSearchOptions,
    ) => {
      const uniquePaths = [...new Set(hits.map((hit) => hit.path))];
      const caseSensitive = options.caseSensitive === true;
      const plans: Array<{ path: string; count: number; content: string; hash: string }> = [];
      for (const relative of uniquePaths) {
        try {
          const document = await codingReadDocument(cwd, workspaceFilePath(cwd, relative));
          const count = countOccurrences(
            document.content,
            query,
            caseSensitive,
            options.regex,
            options.wholeWord,
          );
          if (count > 0) {
            plans.push({ path: relative, count, content: document.content, hash: document.hash });
          }
        } catch {
          // An unreadable file is skipped; the summary reports the shortfall.
        }
      }

      const summary = describeReplacePlan(plans.map(({ path, count }) => ({ path, count })));
      if (plans.length === 0) {
        onToast?.(summary);
        return;
      }
      const confirmed = await confirmTaskAction({
        title: "确认全部替换？",
        description: `${summary}。替换会通过内容哈希避免覆盖期间被其他程序修改的文件。`,
        confirmLabel: "全部替换",
        danger: true,
      });
      if (!confirmed) return;

      const mutation = await prepareManualMutation();
      if (!mutation) return;

      setReplacing(true);
      let changed = 0;
      let skipped = 0;
      let writeFailures = 0;
      try {
        for (const plan of plans) {
          const next = replaceAll(
            plan.content,
            query,
            replacement,
            caseSensitive,
            options.regex,
            options.wholeWord,
          );
          try {
            await codingWriteDocument(
              cwd,
              workspaceFilePath(cwd, plan.path),
              next.content,
              plan.hash,
            );
            changed += 1;
          } catch (error) {
            skipped += 1;
            if (!String(error).includes("保存冲突")) writeFailures += 1;
          }
        }
        if (changed > 0) {
          await finishManualMutation(mutation);
        } else {
          await blockInterruptedManualMutation(mutation, "搜索替换未能写入任何文件");
        }
      } catch (error) {
        const message = String(error).replace(/^Error:\s*/, "");
        await blockInterruptedManualMutation(mutation, `替换后任务同步失败：${message}`);
        onToast?.(`替换未完整完成：${message}`);
        return;
      } finally {
        setReplacing(false);
      }
      onToast?.(
        writeFailures > 0
          ? `已替换 ${changed} 个文件，${writeFailures} 个写入失败，${skipped - writeFailures} 个因冲突跳过`
          : skipped > 0
            ? `已替换 ${changed} 个文件，${skipped} 个因期间被其他程序修改而跳过`
          : `已替换 ${changed} 个文件`,
      );
    },
    [
      blockInterruptedManualMutation,
      confirmTaskAction,
      cwd,
      finishManualMutation,
      onToast,
      prepareManualMutation,
    ],
  );

  // Each recent project keeps its editor/context state for the current app
  // session, so switching projects does not discard unsaved drafts.
  useEffect(() => {
    const previous = previousWorkspaceRef.current;
    if (previous && previous !== cwd) {
      const tabState = useTabStore.getState();
      saveCodingHotExit({
        version: 1,
        root: previous,
        tabs: tabState.tabs,
        activeId: tabState.activeId,
        selectedDirectory,
        expandedPaths: treeExpandedPathsRef.current.get(previous) ?? [],
        minimapEnabled: workspaceUiStateRef.current.get(previous)?.minimapEnabled ?? DEFAULT_MINIMAP_ENABLED,
        savedAt: Date.now(),
      });
      workspaceUiStateRef.current.set(previous, {
        tabs: tabState.tabs,
        activeId: tabState.activeId,
        contextPaths,
        editorContext,
        selectedDirectory,
        minimapEnabled:
          workspaceUiStateRef.current.get(previous)?.minimapEnabled
            ?? DEFAULT_MINIMAP_ENABLED,
      });
    }
    if (previous === cwd) return;
    const memorySaved = cwd ? workspaceUiStateRef.current.get(cwd) : undefined;
    const diskSaved = cwd && !memorySaved ? loadCodingHotExit(cwd) : null;
    const saved = memorySaved ?? (diskSaved ? {
      tabs: diskSaved.tabs,
      activeId: diskSaved.activeId,
      contextPaths: [],
      editorContext: null,
      selectedDirectory: diskSaved.selectedDirectory,
      minimapEnabled: diskSaved.minimapEnabled ?? DEFAULT_MINIMAP_ENABLED,
    } : undefined);
    if (cwd && diskSaved) treeExpandedPathsRef.current.set(cwd, diskSaved.expandedPaths);
    useTabStore.setState({
      tabs: saved?.tabs ?? [],
      activeId: saved?.activeId ?? null,
    });
    if (diskSaved) {
      for (const tab of diskSaved.tabs) {
        if (isFileTab(tab) && !isDirty(tab)) void loadFile(tab.id, true, false);
      }
    }
    setSymbolsByPath({});
    setWorkspaceSymbols([]);
    setEditorContext(saved?.editorContext ?? null);
    setContextPaths(saved?.contextPaths ?? []);
    setSelectedDirectory(saved?.selectedDirectory ?? cwd);
    useFileTreeSelectionStore.getState().clear();
    previousWorkspaceRef.current = cwd;
  }, [cwd, loadFile]);

  useEffect(() => {
    if (!cwd || previousWorkspaceRef.current !== cwd) return;
    const timer = window.setTimeout(persistHotExitNow, 250);
    return () => window.clearTimeout(timer);
  }, [activeTabId, cwd, persistHotExitNow, tabs, treePersistenceRevision, uiStateRevision]);

  useEffect(() => {
    hydrateLayout();
  }, [hydrateLayout]);

  // Build the quick-open index once per workspace, abandoning it if the user
  // switches away mid-walk.
  useEffect(() => {
    if (!cwd) {
      setFilePaths([]);
      return;
    }
    const signal = { aborted: false };
    setIndexing(true);
    setFilePaths([]);
    void buildFileIndex(cwd, {
      signal,
      onProgress: (paths) => {
        if (!signal.aborted) setFilePaths(reconcileFileIndexEvents(paths));
      },
    })
      .then((result) => {
        if (!signal.aborted) setFilePaths(reconcileFileIndexEvents(result.paths));
      })
      .finally(() => {
        if (!signal.aborted) setIndexing(false);
      });
    return () => {
      signal.aborted = true;
    };
  }, [cwd, reconcileFileIndexEvents]);

  const effectiveLayout = useMemo(
    () => fitWorkbenchLayout(workbenchSize.width, workbenchSize.height, {
      explorerWidth,
      agentWidth,
      bottomHeight,
    }),
    [agentWidth, bottomHeight, explorerWidth, workbenchSize.height, workbenchSize.width],
  );
  const startExplorerDrag = useDragWidth(
    effectiveLayout.explorerWidth,
    setExplorerWidth,
    false,
  );
  const startAgentDrag = useDragWidth(effectiveLayout.agentWidth, setAgentWidth, true);

  const pickWorkspace = useCallback(async () => {
    try {
      const picked = await filesystemPickDirectory();
      if (picked) onSelectWorkspace?.(picked);
    } catch (error) {
      onToast?.(`打开文件夹失败：${String(error).replace(/^Error:\s*/, "")}`);
    }
  }, [onSelectWorkspace, onToast]);

  const openAnotherProject = useCallback(() => {
    if (onAddCodingWorkspace) {
      onAddCodingWorkspace();
      return;
    }
    void pickWorkspace();
  }, [onAddCodingWorkspace, pickWorkspace]);

  const createWorkspaceEntry = useCallback(async (directory: boolean) => {
    const name: string | null = await new Promise((resolve) => {
      requestTaskInput({
        title: directory ? "新建目录" : "新建文件",
        fields: [
          {
            name: "name",
            label: "名称",
            placeholder: directory ? "例如 utils" : "例如 note.md",
            required: true,
            maxLength: 240,
          },
        ],
        confirmLabel: "创建",
        action: (values) => {
          resolve(values.name.trim() || null);
        },
      });
    });
    if (!name) return;
    const mutation = directory ? { taskId: null, closeRound: false } : await prepareManualMutation();
    if (!mutation) return;
    let createdFile = false;
    try {
      const created = await codingApi.createEntry(cwd, selectedDirectory || cwd, name, directory);
      createdFile = !directory;
      queueTreeRefresh(created);
      if (!directory) recordFileIndexEvent(created, false);
      if (!directory) await openFile(created);
      if (!directory) await finishManualMutation(mutation);
      onToast?.(`已创建${directory ? "目录" : "文件"} ${name}`);
      // SP5: record for undo.
      useHistoryStackStore.getState().push({
        op: "create",
        cwd,
        path: created,
        isDir: directory,
      });
    } catch (error) {
      const message = String(error).replace(/^Error:\s*/, "");
      await blockInterruptedManualMutation(
        mutation,
        createdFile ? `文件已创建，但任务同步失败：${message}` : `新建文件未能完成：${message}`,
      );
      onToast?.(createdFile ? `文件已创建，但任务同步失败：${message}` : `创建失败：${message}`);
    }
  }, [
    blockInterruptedManualMutation,
    cwd,
    finishManualMutation,
    onToast,
    openFile,
    prepareManualMutation,
    queueTreeRefresh,
    recordFileIndexEvent,
    requestTaskInput,
    selectedDirectory,
  ]);

  // ---- SP1: file ops helpers ----

  const basenameOf = useCallback((path: string): string => {
    const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    return idx >= 0 ? path.slice(idx + 1) : path;
  }, []);

  const dirnameOf = useCallback((path: string): string => {
    const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    return idx > 0 ? path.slice(0, idx) : path;
  }, []);

  const normalizePath = useCallback((path: string): string =>
    path.replace(/\\/g, "/").replace(/\/+$/, ""), []);

  const pathContains = useCallback((parent: string, candidate: string): boolean => {
    const normalizedParent = normalizePath(parent);
    const normalizedCandidate = normalizePath(candidate);
    return normalizedCandidate === normalizedParent
      || normalizedCandidate.startsWith(`${normalizedParent}/`);
  }, [normalizePath]);

  const collapseNestedPaths = useCallback((paths: string[]): string[] => {
    const unique = [...new Set(paths)].sort((left, right) =>
      normalizePath(left).length - normalizePath(right).length,
    );
    return unique.filter((candidate, index) =>
      !unique.slice(0, index).some((parent) => pathContains(parent, candidate)),
    );
  }, [normalizePath, pathContains]);

  const findDirtyTabsFor = useCallback((paths: string[]) => {
    return useTabStore.getState().tabs.filter(
      (tab) => isDirty(tab) && paths.some((path) => pathContains(path, tab.id)),
    );
  }, [pathContains]);

  const performRename = useCallback(
    async (path: string, newName: string) => {
      try {
        const result = await codingApi.renameEntry(cwd, path, newName);
        queueTreeRefreshPaths([result.path, result.oldPath]);
        // If the renamed file is open in a tab, swap the tab id.
        useTabStore.getState().renameTab(result.oldPath, result.path);
        setRenamingPath(null);
        onToast?.(`已重命名为 ${basenameOf(result.path)}`);
        // SP5: record for undo (rebuild original basename for restoration).
        useHistoryStackStore.getState().push({
          op: "rename",
          cwd,
          oldPath: result.oldPath,
          newPath: result.path,
        });
      } catch (error) {
        const message = String(error).replace(/^Error:\s*/, "");
        onToast?.(`重命名失败：${message}`);
        throw error;
      }
    },
    [basenameOf, cwd, onToast, queueTreeRefreshPaths],
  );

  const performDelete = useCallback(
    async (paths: string[]) => {
      try {
        const results = await codingApi.deleteEntries(cwd, paths);
        const succeeded = results.filter(
          (result): result is typeof result & { restoreToken: string } =>
            result.ok && typeof result.restoreToken === "string" && result.restoreToken.length > 0,
        );
        const failed = results.filter((result) => !result.ok || !result.restoreToken);
        const succeededPaths = succeeded.map((result) => result.sourcePath);
        queueTreeRefreshPaths(succeededPaths);
        for (const tab of useTabStore.getState().tabs) {
          if (succeededPaths.some((path) => pathContains(path, tab.id))) {
            useTabStore.getState().markConflict(tab.id);
            useTabStore.getState().setError(tab.id, "文件已移到回收站，可通过撤销恢复。");
          }
        }
        if (succeeded.length > 0) {
          useHistoryStackStore.getState().push({
            op: "delete",
            cwd,
            items: succeeded.map((result) => ({
              path: result.sourcePath,
              restoreToken: result.restoreToken,
            })),
          });
        }
        const failedPaths = failed.map((result) => result.sourcePath);
        useFileTreeSelectionStore.getState().select(failedPaths);
        const clipboard = useClipboardStore.getState();
        const remainingClipboardPaths = clipboard.paths.filter((path) =>
          !succeededPaths.some((deletedPath) => pathContains(deletedPath, path)));
        if (remainingClipboardPaths.length !== clipboard.paths.length) {
          if (remainingClipboardPaths.length === 0) clipboard.clear();
          else if (clipboard.mode === "cut") clipboard.setCut(remainingClipboardPaths);
          else clipboard.setCopy(remainingClipboardPaths);
        }
        if (failed.length > 0) {
          const first = failed[0];
          onToast?.(
            succeeded.length > 0
              ? `已移到回收站 ${succeeded.length} 个，${failed.length} 个失败：${first.error ?? "未取得恢复标识"}`
              : `删除失败：${first.error ?? "未取得恢复标识"}`,
          );
        } else {
          onToast?.(`已移到回收站 ${succeeded.length} 个条目`);
        }
      } catch (error) {
        const message = String(error).replace(/^Error:\s*/, "");
        onToast?.(`删除失败：${message}`);
        throw error;
      }
    },
    [cwd, onToast, pathContains, queueTreeRefreshPaths],
  );

  const confirmDelete = useCallback(
    async (paths: string[]) => {
      const targets = collapseNestedPaths(paths);
      if (targets.length === 0) return;
      const dirty = findDirtyTabsFor(targets);
      if (dirty.length > 0) {
        await new Promise<void>((resolve) => {
          requestTaskConfirmation({
            title: `${dirty.length} 个文件有未保存改动`,
            description: "继续删除会丢弃这些改动。确定要继续吗？",
            confirmLabel: "强制删除",
            danger: true,
            action: async () => {
              resolve();
            },
          });
        });
      }
      const isMulti = targets.length > 1;
      await new Promise<void>((resolve, reject) => {
        requestTaskConfirmation({
          title: isMulti
            ? `删除 ${targets.length} 个条目`
            : `删除 “${basenameOf(targets[0])}”`,
          description: "所选条目将被移到操作系统的回收站，可从回收站恢复。",
          confirmLabel: "移到回收站",
          cancelLabel: "取消",
          danger: true,
          action: async () => {
            try {
              await performDelete(targets);
              resolve();
            } catch (error) {
              reject(error);
            }
          },
        });
      });
    },
    [basenameOf, collapseNestedPaths, findDirtyTabsFor, performDelete, requestTaskConfirmation],
  );

  const performPaste = useCallback(
    async (destDir: string) => {
      const cb = useClipboardStore.getState();
      if (cb.paths.length === 0 || !cwd) return;
      // Pre-check: every source must live under cwd for the backend to accept it.
      const clipboardSources = collapseNestedPaths(cb.paths);
      const validSources = clipboardSources.filter(
        (path) => pathContains(cwd, path) && normalizePath(path) !== normalizePath(cwd),
      );
      const invalidSources = clipboardSources.filter((path) => !validSources.includes(path));
      if (validSources.length === 0) {
        onToast?.("剪贴板中的条目不在当前工作区内，无法粘贴");
        return;
      }
      try {
        const api = cb.mode === "cut" ? codingApi.moveEntries : codingApi.copyEntries;
        const results = await api(cwd, validSources, destDir);
        const succeeded = results.filter((result) => result.ok);
        const failed = results.filter((result) => !result.ok);
        queueTreeRefreshPaths([
          ...succeeded.map((result) => result.sourcePath),
          ...succeeded.map((result) => result.path),
          destDir,
        ]);
        if (cb.mode === "cut") {
          for (const result of succeeded) {
            useTabStore.getState().renameTab(result.sourcePath, result.path);
          }
        }
        // SP5: record paste for undo. For `cut`, undo = move back to source
        // parent; for `copy`, undo = delete the created copies. Snapshot the
        // created paths BEFORE `clear()` so we can still reach them.
        const created = succeeded.map((result) => result.path);
        if (created.length > 0) {
          useHistoryStackStore.getState().push({
            op: "paste",
            cwd,
            mode: cb.mode,
            sources: succeeded.map((result) => result.sourcePath),
            destination: destDir,
            finalPaths: created,
          });
        }
        if (cb.mode === "cut") {
          const failedSources = [
            ...invalidSources,
            ...failed.map((result) => result.sourcePath),
          ];
          if (failedSources.length > 0) {
            useClipboardStore.getState().setCut(failedSources);
            useFileTreeSelectionStore.getState().select(failedSources);
          } else {
            useClipboardStore.getState().clear();
            useFileTreeSelectionStore.getState().clear();
          }
        }
        const failedCount = failed.length + invalidSources.length;
        if (failedCount > 0) {
          onToast?.(
            `${cb.mode === "cut" ? "移动" : "复制"}完成 ${succeeded.length} 个，失败 ${failedCount} 个：${failed[0]?.error ?? "部分条目不在当前工作区"}`,
          );
        } else {
          onToast?.(`${cb.mode === "cut" ? "已移动" : "已复制"} ${succeeded.length} 个条目`);
        }
      } catch (error) {
        const message = String(error).replace(/^Error:\s*/, "");
        onToast?.(`粘贴失败：${message}`);
      }
    },
    [collapseNestedPaths, cwd, normalizePath, onToast, pathContains, queueTreeRefreshPaths],
  );

  // SP5: undo / redo for the six core file operations.
  const performHistoryAction = useCallback(
    async (direction: "undo" | "redo") => {
      const store = useHistoryStackStore.getState();
      const entry = direction === "undo" ? store.peekUndo(cwd) : store.peekRedo(cwd);
      if (!entry) {
        onToast?.(direction === "undo" ? "没有可撤销的操作" : "没有可重做的操作");
        return;
      }
      try {
        let updated = entry;
        const requireBatchSuccess = <T extends { ok: boolean; error?: string | null },>(
          results: T[],
          action: string,
        ): T[] => {
          const failed = results.find((result) => !result.ok);
          if (failed) throw new Error(`${action}未完整完成：${failed.error ?? "未知错误"}`);
          return results;
        };
        const deleteForUndo = async (paths: string[]) => {
          const results = await codingApi.deleteEntries(cwd, paths);
          const successful = results.filter(
            (result): result is typeof result & { restoreToken: string } =>
              result.ok && typeof result.restoreToken === "string" && result.restoreToken.length > 0,
          );
          const failed = results.filter((result) => !result.ok || !result.restoreToken);
          if (failed.length > 0) {
            // Undo/redo is presented as one operation. Roll successful items
            // back when the batch is incomplete so the file system and the
            // history cursor cannot drift apart.
            const rollback = successful.length > 0
              ? await codingApi.restoreFromTrash(
                  cwd,
                  successful.map((result) => result.sourcePath),
                  successful.map((result) => result.restoreToken),
                )
              : [];
            const rollbackFailure = rollback.find((result) => !result.ok);
            if (rollbackFailure) {
              throw new Error(
                `移到回收站未完整完成，自动回滚也失败：${rollbackFailure.error ?? "未知错误"}`,
              );
            }
            throw new Error(`移到回收站未完整完成：${failed[0]?.error ?? "未取得恢复标识"}`);
          }
          for (const result of successful) {
            for (const tab of useTabStore.getState().tabs) {
              if (pathContains(result.sourcePath, tab.id)) {
                useTabStore.getState().markConflict(tab.id);
                useTabStore.getState().setError(tab.id, "文件已移到回收站，可通过重做或撤销恢复。");
              }
            }
          }
          return successful.map((result) => {
            return { path: result.sourcePath, restoreToken: result.restoreToken };
          });
        };
        const restore = async (items: Array<{ path: string; restoreToken: string }>) => {
          requireBatchSuccess(await codingApi.restoreFromTrash(
            cwd,
            items.map((item) => item.path),
            items.map((item) => item.restoreToken),
          ), "恢复");
          for (const item of items) {
            for (const tab of useTabStore.getState().tabs) {
              if (pathContains(item.path, tab.id)) useTabStore.getState().clearConflict(tab.id);
            }
          }
        };
        const moveTransaction = async (
          requests: Array<{ path: string; destination: string }>,
          action: string,
        ) => {
          const grouped = new Map<string, string[]>();
          for (const request of requests) {
            grouped.set(request.destination, [
              ...(grouped.get(request.destination) ?? []),
              request.path,
            ]);
          }
          const applied: Array<{ sourcePath: string; path: string }> = [];
          let failure: string | null = null;
          for (const [destination, paths] of grouped) {
            try {
              const results = await codingApi.moveEntries(cwd, paths, destination);
              applied.push(...results.filter((result) => result.ok));
              const failed = results.find((result) => !result.ok);
              if (failed || results.length !== paths.length) {
                failure = failed?.error ?? "原生文件操作返回结果不完整";
                break;
              }
            } catch (error) {
              failure = String(error).replace(/^Error:\s*/, "");
              break;
            }
          }
          if (failure) {
            const rollbackFailures: string[] = [];
            for (const moved of [...applied].reverse()) {
              if (normalizePath(moved.sourcePath) === normalizePath(moved.path)) continue;
              try {
                const rollback = await codingApi.moveEntries(
                  cwd,
                  [moved.path],
                  dirnameOf(moved.sourcePath),
                );
                const failed = rollback.length === 1 && rollback[0]?.ok
                  ? undefined
                  : rollback.find((result) => !result.ok) ?? { error: "原生文件操作返回结果不完整" };
                if (failed) {
                  rollbackFailures.push(failed.error ?? moved.path);
                  useTabStore.getState().renameTab(moved.sourcePath, moved.path);
                }
              } catch (error) {
                rollbackFailures.push(String(error).replace(/^Error:\s*/, ""));
                useTabStore.getState().renameTab(moved.sourcePath, moved.path);
              }
            }
            throw new Error(
              rollbackFailures.length > 0
                ? `${action}未完整完成，且 ${rollbackFailures.length} 个条目自动回滚失败：${rollbackFailures[0]}`
                : `${action}未完整完成，已自动回滚：${failure}`,
            );
          }
          for (const moved of applied) {
            useTabStore.getState().renameTab(moved.sourcePath, moved.path);
          }
          return applied;
        };
        const movePairsBack = async (pairs: Array<{ sourcePath: string; finalPath: string }>) => {
          await moveTransaction(
            pairs.map((pair) => ({
              path: pair.finalPath,
              destination: dirnameOf(pair.sourcePath),
            })),
            "移回原位置",
          );
        };
        switch (entry.op) {
          case "rename": {
            const source = direction === "undo" ? entry.newPath : entry.oldPath;
            const target = direction === "undo" ? entry.oldPath : entry.newPath;
            const result = await codingApi.renameEntry(cwd, source, basenameOf(target));
            useTabStore.getState().renameTab(result.oldPath, result.path);
            break;
          }
          case "delete": {
            if (direction === "undo") {
              await restore(entry.items);
            } else {
              updated = { ...entry, items: await deleteForUndo(entry.items.map((item) => item.path)) };
            }
            break;
          }
          case "create": {
            if (direction === "undo") {
              const [trashedItem] = await deleteForUndo([entry.path]);
              updated = { ...entry, trashedItem };
            } else {
              if (!entry.trashedItem) throw new Error("缺少新建条目的恢复标识");
              await restore([entry.trashedItem]);
              updated = { ...entry, trashedItem: undefined };
            }
            break;
          }
          case "copy": {
            if (direction === "undo") {
              updated = { ...entry, trashedCopies: await deleteForUndo(entry.createdPaths) };
            } else {
              if (!entry.trashedCopies) throw new Error("缺少复制条目的恢复标识");
              await restore(entry.trashedCopies);
              updated = { ...entry, trashedCopies: undefined };
            }
            break;
          }
          case "move": {
            if (direction === "undo") await movePairsBack(entry.moves);
            else {
              await moveTransaction(
                entry.moves.map((move) => ({
                  path: move.sourcePath,
                  destination: entry.destination,
                })),
                "重新移动",
              );
            }
            break;
          }
          case "paste": {
            if (entry.mode === "cut") {
              const pairs = entry.sources.map((sourcePath, index) => ({
                sourcePath,
                finalPath: entry.finalPaths[index]!,
              }));
              if (direction === "undo") await movePairsBack(pairs);
              else {
                await moveTransaction(
                  entry.sources.map((path) => ({ path, destination: entry.destination })),
                  "重新移动",
                );
              }
            } else if (direction === "undo") {
              updated = { ...entry, trashedCopies: await deleteForUndo(entry.finalPaths) };
            } else {
              if (!entry.trashedCopies) throw new Error("缺少复制条目的恢复标识");
              await restore(entry.trashedCopies);
              updated = { ...entry, trashedCopies: undefined };
            }
            break;
          }
        }
        if (direction === "undo") store.commitUndo(cwd, updated);
        else store.commitRedo(cwd, updated);
        queueTreeRefreshPaths([cwd]);
        onToast?.(direction === "undo" ? "已撤销" : "已重做");
      } catch (error) {
        const message = String(error).replace(/^Error:\s*/, "");
        // Most failures are rolled back, but a platform-level rollback can
        // itself fail. Refresh from disk so the explorer never claims a stale
        // state in that exceptional case.
        queueTreeRefreshPaths([cwd]);
        onToast?.(`${direction === "undo" ? "撤销" : "重做"}失败：${message}`);
      }
    },
    [basenameOf, cwd, dirnameOf, onToast, pathContains, queueTreeRefreshPaths],
  );

  const handleFileTreeContextMenu = useCallback(
    (event: React.MouseEvent, entry: { path: string; kind: string }) => {
      event.preventDefault();
      const sel = useFileTreeSelectionStore.getState();
      if (!sel.selectedPaths.has(entry.path)) {
        sel.select([entry.path], entry.path);
      }
      const current = useFileTreeSelectionStore.getState().selectedPaths;
      const kind = entry.kind === "directory" ? "directory" : "file";
      const pasteTargetDir =
        kind === "directory" ? entry.path : dirnameOf(entry.path);
      setContextMenu({
        x: event.clientX,
        y: event.clientY,
        primaryPath: entry.path,
        primaryKind: kind,
        selectedPaths: Array.from(current),
        pasteTargetDir,
      });
    },
    [dirnameOf],
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
      documentationTarget?: EditorCodeContext,
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
        const documentation = isDocumentationRequest(trimmedRequirement)
          ? await resolveDocumentationWorkflow(trimmedRequirement, documentationTarget)
          : undefined;
        const effectiveContextPaths = [...new Set([
          ...contextPaths,
          ...additionalContextPaths,
          ...(documentation?.request.target?.path ? [documentation.request.target.path] : []),
        ].map((path) => workspaceRelativePath(cwd, path)).filter(Boolean))];
        const managedPrompt = documentation
          ? buildCodingWorkflowPrompt(
              trimmedRequirement,
              effectiveContextPaths,
              false,
              { documentation },
            )
          : undefined;
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
        const session = managedPrompt
          ? await onStartRun(
              cwd,
              trimmedRequirement,
              modelId,
              effectiveContextPaths,
              bindSession,
              managedPrompt,
            )
          : await onStartRun(
              cwd,
              trimmedRequirement,
              modelId,
              effectiveContextPaths,
              bindSession,
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
    [contextPaths, cwd, deriveName, modelId, onStartRun, resolveDocumentationWorkflow],
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
        const documentation = !managedPrompt && isDocumentationRequest(text)
          ? await resolveDocumentationWorkflow(text)
          : undefined;
        const documentationPaths = documentation?.request.target?.path
          ? [documentation.request.target.path]
          : [];
        const effectiveContextPaths = [...new Set([...contextPaths, ...documentationPaths])];
        const promptTextOverride = managedPrompt ?? (task
          ? buildCodingWorkflowPrompt(
              text,
              effectiveContextPaths,
              true,
              documentation ? { documentation } : undefined,
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
      resolveDocumentationWorkflow,
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
    setPhaseReason(undefined);
    setBlocker(undefined);
  }, [activeTaskCount, onToast]);

  // ---- SP3: AI actions (right-click submenu) ----

  /** Heuristic test-framework detector based on `package.json` deps in cwd. */
  const inferTestFramework = useCallback(async (_samplePath: string): Promise<string | null> => {
    if (!cwd) return null;
    try {
      const pkgPath = cwd + "/package.json";
      const exists = await codingReadDocument(cwd, pkgPath).catch(() => null);
      if (!exists) return null;
      const content = (exists.content ?? "").toLowerCase();
      if (content.includes("vitest")) return "vitest";
      if (content.includes("jest")) return "jest";
      if (content.includes("mocha")) return "mocha";
      return null;
    } catch {
      return null;
    }
  }, [cwd]);

  /** SP3: AI review — pre-read every selected file and embed in the prompt. */
  const requestReview = useCallback(async (paths: string[]) => {
    if (paths.length === 0) return;
    if (!cwd) return;
    if (!task && (!apiReady || !modelId)) {
      onToast?.("请先配置可用模型");
      onOpenSettings?.();
      return;
    }
    try {
      const docs: DocumentSnippet[] = await Promise.all(
        paths.map(async (p) => {
          const doc = await codingReadDocument(cwd, p).catch(() => null);
          return {
            path: p,
            hash: doc?.hash ?? "",
            content: doc?.content ?? "(无法读取文件内容)",
          };
        }),
      );
      const requirement = buildReviewPrompt(docs);
      await startTask(requirement, undefined);
    } catch (error) {
      const message = String(error).replace(/^Error:\s*/, "");
      onToast?.(`AI 评审发起失败：${message}`);
    }
  }, [apiReady, cwd, modelId, onOpenSettings, onToast, startTask]);

  /** SP3: AI refactor suggestions — collect optional user note + run. */
  const requestRefactor = useCallback(async (paths: string[]) => {
    if (paths.length === 0) return;
    if (!cwd) return;
    if (!task && (!apiReady || !modelId)) {
      onToast?.("请先配置可用模型");
      onOpenSettings?.();
      return;
    }
    const userNote: string | null = await new Promise((resolve) => {
      requestTaskInput({
        title: "AI 重构建议",
        description: `将对 ${paths.length} 个文件给出重构建议。可填写关注点（如「拆分大函数」「统一错误处理」），留空则让 Agent 自行判断。`,
        fields: [{
          name: "note",
          label: "关注点",
          placeholder: "可选：你重点关注的重构方向…",
          multiline: true,
          maxLength: 600,
        }],
        confirmLabel: "生成建议",
        action: (values) => resolve(values.note ?? ""),
      });
    });
    if (userNote === null) return;
    try {
      const requirement = buildRefactorPrompt(paths, userNote);
      await startTask(requirement, undefined);
    } catch (error) {
      const message = String(error).replace(/^Error:\s*/, "");
      onToast?.(`AI 重构发起失败：${message}`);
    }
  }, [apiReady, cwd, modelId, onOpenSettings, onToast, requestTaskInput, startTask]);

  /** SP3: AI test generation — infer framework, collect note, run. */
  const requestTests = useCallback(async (paths: string[]) => {
    if (paths.length === 0) return;
    if (!cwd) return;
    if (!task && (!apiReady || !modelId)) {
      onToast?.("请先配置可用模型");
      onOpenSettings?.();
      return;
    }
    const inferred = await inferTestFramework(paths[0] ?? cwd);
    const userNote: string | null = await new Promise((resolve) => {
      requestTaskInput({
        title: "AI 生成测试",
        description: `将为 ${paths.length} 个文件生成测试。检测到框架：${inferred ?? "未知"}。可填写覆盖目标或边界条件，留空则让 Agent 自行决定。`,
        fields: [{
          name: "note",
          label: "覆盖要求",
          placeholder: "可选：想覆盖的边界 / 错误路径…",
          multiline: true,
          maxLength: 600,
        }],
        confirmLabel: "生成测试",
        action: (values) => resolve(values.note ?? ""),
      });
    });
    if (userNote === null) return;
    try {
      const requirement = buildTestsPrompt(paths, inferred, userNote);
      await startTask(requirement, undefined);
    } catch (error) {
      const message = String(error).replace(/^Error:\s*/, "");
      onToast?.(`AI 测试生成发起失败：${message}`);
    }
  }, [apiReady, cwd, inferTestFramework, modelId, onOpenSettings, onToast, requestTaskInput, startTask]);

  /** SP3: «在对话中提问» — start a real task with the selected paths attached. */
  const promptAskInConversation = useCallback(async (paths: string[]) => {
    if (!cwd) return;
    const question: string | null = await new Promise((resolve) => {
      requestTaskInput({
        title: paths.length === 0 ? "向 AI 提问" : "在对话中提问",
        description: paths.length > 0
          ? `已自动附加 ${paths.length} 个文件作为上下文。`
          : "提交后将创建新任务并跳转。",
        fields: [{
          name: "question",
          label: "问题",
          placeholder: "请输入你的问题…",
          multiline: true,
          required: true,
          maxLength: 2000,
        }],
        confirmLabel: "开始对话",
        action: (values) => resolve(values.question ?? ""),
      });
    });
    if (question === null || !question.trim()) return;
    onToast?.("正在创建 AI 对话…");
    if (onStartRun) {
      try {
        await startTask(question.trim(), undefined, paths);
      } catch (error) {
        const message = String(error).replace(/^Error:\s*/, "");
        onToast?.(`发起对话失败：${message}`);
      }
    }
  }, [cwd, onStartRun, onToast, requestTaskInput, startTask]);

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

  const clearContext = useCallback(() => {
    setContextPaths([]);
    if (task) {
      persistTaskContext(task.id, []);
    }
  }, [persistTaskContext, task]);
  const buildContextMenuItems = useCallback(
    (target: NonNullable<typeof contextMenu>): ContextMenuItem[] => {
      const cb = useClipboardStore.getState();
      const primaryIsDir = target.primaryKind === "directory";
      const singleSelected = target.selectedPaths.length === 1;
      const items: ContextMenuItem[] = [];

      // SP5: undo entry comes first so it's reachable via "Z" muscle memory.
      const undoEntry = useHistoryStackStore.getState().peekUndo(cwd);
      if (undoEntry) {
        items.push({
          id: "undo",
          label: `撤销 ${humanOpLabel(undoEntry.op)}`,
          shortcut: shortcutLabel("⌘Z", "Ctrl+Z"),
          onSelect: () => void performHistoryAction("undo"),
        });
        items.push({ kind: "separator", id: "sep-undo", dividerBefore: true });
      }

      items.push({ kind: "label", id: "label-system", label: "基本操作" });
      items.push({
        id: "open",
        label: primaryIsDir ? "展开目录" : "打开",
        onSelect: () => {
          if (primaryIsDir) {
            setSelectedDirectory(target.primaryPath);
          } else {
            void openFile(target.primaryPath);
          }
        },
      });
      items.push({
        id: "rename",
        label: "重命名",
        shortcut: "F2",
        disabled: !singleSelected,
        onSelect: () => {
          setRenamingPath(target.primaryPath);
        },
      });

      items.push({ kind: "separator", id: "sep-clipboard", dividerBefore: true });
      items.push({ kind: "label", id: "label-clipboard", label: "剪贴板" });
      items.push({
        id: "copy",
        label: "复制",
        shortcut: shortcutLabel("⌘C", "Ctrl+C"),
        onSelect: () => {
          useClipboardStore.getState().setCopy(target.selectedPaths);
          onToast?.(`已复制 ${target.selectedPaths.length} 个条目`);
        },
      });
      items.push({
        id: "cut",
        label: "剪切",
        shortcut: shortcutLabel("⌘X", "Ctrl+X"),
        onSelect: () => {
          useClipboardStore.getState().setCut(target.selectedPaths);
          onToast?.(`已剪切 ${target.selectedPaths.length} 个条目`);
        },
      });
      items.push({
        id: "paste",
        label: "粘贴到此处",
        shortcut: shortcutLabel("⌘V", "Ctrl+V"),
        disabled: cb.paths.length === 0,
        onSelect: () => {
          void performPaste(target.pasteTargetDir);
        },
      });

      // SP3: AI actions submenu (replaces the SP1 placeholder).
      items.push({ kind: "separator", id: "sep-ai", dividerBefore: true });
      items.push({ kind: "label", id: "label-ai", label: "AI 操作" });

      // The 4 single-step AI actions only make sense on a file. Directories
      // keep a tooltip explaining the constraint.
      const fileOnlyTooltip = "暂不支持对目录执行此操作（SP4 评估）";
      const filesSelected = target.selectedPaths.filter((p) => !p.endsWith("/"));

      items.push({
        id: "ai-explain",
        label: "AI 解释",
        icon: <Sparkles size={12} aria-hidden />,
        disabled: filesSelected.length === 0,
        tooltip: filesSelected.length === 0 ? fileOnlyTooltip : undefined,
        onSelect: () => {
          const paths = filesSelected.length > 0 ? filesSelected : target.selectedPaths;
          // Reuse the existing Agent-prompt pipeline rather than calling
          // `requestExplanation` (which is the inline single-file explainer).
          const instruction = `请基于真实代码解释 ${paths.join(", ")} 的职责、关键数据流、依赖关系、边界条件、业务规则与潜在风险。只分析，不修改文件。`;
          void startTask(instruction, undefined);
        },
      });
      items.push({
        id: "ai-review",
        label: "AI 评审",
        icon: <ShieldCheck size={12} aria-hidden />,
        onSelect: () => void requestReview(target.selectedPaths),
      });
      items.push({
        id: "ai-refactor",
        label: "AI 重构建议",
        icon: <Hammer size={12} aria-hidden />,
        disabled: filesSelected.length === 0,
        tooltip: filesSelected.length === 0 ? fileOnlyTooltip : undefined,
        onSelect: () => {
          const paths = filesSelected.length > 0 ? filesSelected : target.selectedPaths;
          void requestRefactor(paths);
        },
      });
      items.push({
        id: "ai-tests",
        label: "AI 生成测试",
        icon: <FlaskConical size={12} aria-hidden />,
        disabled: filesSelected.length === 0,
        tooltip: filesSelected.length === 0 ? fileOnlyTooltip : undefined,
        onSelect: () => {
          const paths = filesSelected.length > 0 ? filesSelected : target.selectedPaths;
          void requestTests(paths);
        },
      });

      items.push({
        id: "ai-add-context",
        label: target.selectedPaths.length > 1
          ? `加入 ${target.selectedPaths.length} 个到上下文`
          : "加入上下文",
        icon: <Plus size={12} aria-hidden />,
        onSelect: () => addManyToContext(target.selectedPaths),
      });

      items.push({
        id: "ai-ask",
        label: "在对话中提问…",
        icon: <MessageSquare size={12} aria-hidden />,
        onSelect: () => void promptAskInConversation(target.selectedPaths),
      });

      items.push({
        kind: "separator",
        id: "sep-danger",
        dividerBefore: true,
      });
      items.push({
        id: "delete",
        label: target.selectedPaths.length === 1
          ? `删除 “${basenameOf(target.primaryPath)}”`
          : `删除 ${target.selectedPaths.length} 个条目`,
        danger: true,
        onSelect: () => {
          void confirmDelete(target.selectedPaths);
        },
      });
      return items;
    },
    [
      basenameOf,
      confirmDelete,
      cwd,
      onToast,
      openFile,
      performPaste,
      setSelectedDirectory,
      addManyToContext,
      promptAskInConversation,
      requestReview,
      requestRefactor,
      requestTests,
      startTask,
      performHistoryAction,
    ],
  );

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
        const tabStore = useTabStore.getState();
        for (const tab of tabStore.tabs) {
          if (isFileTab(tab) && tab.diffTaskId === summary.id) tabStore.clearDiff(tab.id);
        }
        if (wasActive) {
          tabStore.closeTab("doc:delivery");
          tabStore.closeTab("doc:taskDag");
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
      onCancelRun?.();
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
    const changeKinds = new Map(
      (changeSet?.changes ?? []).map((change) => [change.path, change.kind] as const),
    );
    const changePaths = new Set(changeKinds.keys());
    const dirtyTaskTabs = useTabStore.getState().tabs.filter((tab) =>
      isFileTab(tab)
      && tab.draft !== tab.original
      && changePaths.has(workspaceRelativePath(cwd, tab.relativePath)),
    );
    const confirmed = await confirmTaskAction({
      title: `回滚当前任务的 ${count} 个文件？`,
      description: dirtyTaskTabs.length > 0
        ? `将精确恢复任务开始时的内容，并放弃 ${dirtyTaskTabs.length} 个任务文件中未保存的草稿。恢复后的文件会保持打开，其他标签和草稿会保留。`
        : "将精确恢复任务开始时的内容。恢复后的文件会保持打开，与本任务无关的标签和草稿会保留。",
      confirmLabel: "回滚任务",
      danger: true,
    });
    if (!confirmed) return;
    try {
      const restored = await codingApi.rollbackTask(cwd, task.id);
      await useTaskStore.getState().refreshTaskState();
      const restoredPaths = new Set(restored.map((path) => workspaceRelativePath(cwd, path)));
      const tabStore = useTabStore.getState();
      for (const tab of [...tabStore.tabs]) {
        if (!isFileTab(tab)) continue;
        const relativePath = workspaceRelativePath(cwd, tab.relativePath);
        if (!restoredPaths.has(relativePath)) continue;
        // Files created by the task no longer exist after rollback; every
        // other restored file stays in place and refreshes to its baseline.
        if (changeKinds.get(relativePath) === "added") tabStore.closeTab(tab.id);
        else await loadFile(tab.id, true, false);
      }
      onToast?.(`已回滚 ${restored.length} 个文件`);
    } catch (error) {
      onToast?.(`回滚失败：${String(error).replace(/^Error:\s*/, "")}`);
    }
  }, [changeSet?.changes, confirmTaskAction, cwd, loadFile, onToast, task]);

  const discardChange = useCallback(
    async (path: string) => {
      if (!cwd || !task) return;
      const tab = matchingOpenFileTab(path);
      const hasDraft = Boolean(tab && isFileTab(tab) && tab.draft !== tab.original);
      const confirmed = await confirmTaskAction({
        title: `丢弃 ${path} 的全部改动？`,
        description: hasDraft
          ? "该文件还有未保存草稿，丢弃后将恢复任务开始时的内容。"
          : "该文件将恢复为任务开始时的内容。",
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
        const openTab = matchingOpenFileTab(path);
        if (openTab) useTabStore.getState().closeTab(openTab.id);
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

  const openProblem = useCallback(
    (problem: Problem) => {
      if (!problem.file) return;
      void openFile(workspaceFilePath(cwd, problem.file));
      setReveal({ line: problem.line ?? 1, column: problem.column ?? 1, key: Date.now() });
    },
    [cwd, openFile],
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

  const requestExplanation = useCallback(async (
    scope: "function" | "class" | "module" | "system",
  ) => {
    if (!cwd) return;
    if (!task && (!apiReady || !modelId)) {
      onToast?.("请先配置可用模型");
      onOpenSettings?.();
      return;
    }
    const target = scope === "system"
      ? "当前代码库的系统级整体架构与跨模块调用链"
      : `${activeRelativePath ?? "当前文件"}中的当前${scope === "function" ? "函数" : scope === "class" ? "类" : "模块级内容"}`;
    const instruction = `请解释${target}：基于真实代码和测试说明职责、关键数据流、依赖关系、边界条件、业务规则和潜在风险。只做分析，不修改文件。`;
    if (!task) {
      await startTask(instruction, scope === "system" ? undefined : editorContext ?? undefined);
      return;
    }
    const documentation = await resolveDocumentationWorkflow(
      instruction,
      scope === "system" ? undefined : editorContext ?? undefined,
    );
    const prompt = buildCodingWorkflowPrompt(
      instruction,
      documentation.request.target?.path ? [documentation.request.target.path] : [],
      true,
      { documentation },
    );
    await sendFollowup(instruction, false, prompt);
  }, [
    activeRelativePath,
    apiReady,
    cwd,
    editorContext,
    modelId,
    onOpenSettings,
    onToast,
    resolveDocumentationWorkflow,
    sendFollowup,
    startTask,
    task,
  ]);

  const generateComments = useCallback(async (override?: EditorCodeContext) => {
    const current = activeFileTab;
    if (!current) {
      onToast?.("请先打开需要补充注释的文件");
      return;
    }
    if (current.view === "diff") {
      onToast?.("请先切换到编辑视图，再选择需要文档化的代码");
      return;
    }
    if (current.draft !== current.original) {
      onToast?.("当前文件有未保存修改；请先保存，避免 Agent 根据过期内容生成注释");
      return;
    }
    if (streaming || sending || isBusyPhase(task?.phase)) {
      onToast?.("当前 Agent 仍在处理任务，请等待本轮完成后再生成注释");
      return;
    }
    if (!task && (!apiReady || !modelId)) {
      onToast?.("请先配置可用模型");
      onOpenSettings?.();
      return;
    }

    const candidate = override ?? editorContext ?? undefined;
    const target = candidate
      && normalizedRelativePath(candidate.path) === normalizedRelativePath(current.relativePath)
      ? candidate
      : undefined;
    const focused = Boolean(target?.selectedText.trim() || target?.symbol);
    const targetDescription = target?.selectedText.trim()
      ? `${current.relativePath} 第 ${target.startLine}-${target.endLine} 行选中的代码`
      : target?.symbol
        ? `${current.relativePath} 中的${target.symbol.name} 符号`
        : `${current.relativePath} 当前文件`;
    const instruction = `请为${targetDescription}${focused ? "" : "进行模块级分析并"}补充必要、简洁且语义一致的代码注释与公开 API 文档。说明非显然的业务规则、边界条件、副作用和必要的外部调用关系；以当前选区、符号或文件为修改边界，不复述语法，不改变任何可执行逻辑，保持项目既有风格并直接修改文件。`;
    if (!task) {
      await startTask(instruction, target);
      return;
    }
    const documentation = await resolveDocumentationWorkflow(instruction, target);
    const prompt = buildCodingWorkflowPrompt(
      instruction,
      documentation.request.target?.path ? [documentation.request.target.path] : [],
      true,
      { documentation },
    );
    await sendFollowup(instruction, true, prompt);
  }, [
    activeFileTab,
    apiReady,
    editorContext,
    modelId,
    onOpenSettings,
    onToast,
    resolveDocumentationWorkflow,
    sendFollowup,
    sending,
    startTask,
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

  /** Commands backed by the current task, verification and navigation state. */
  const taskChangeCount = changeSet?.changes.length ?? 0;

  const commandContext = useMemo<CommandContext>(
    () => ({
      hasWorkspace: Boolean(cwd),
      hasActiveFile: Boolean(activeFileTab),
      hasTask: Boolean(task),
      busy: streaming || isBusyPhase(task?.phase),
      taskPhase: task?.phase,
      problemCount: combinedProblems.length,
      changedFileCount: taskChangeCount,
      canCommitChanges: changeSet?.baselineMode !== "filesystem",
      canRollbackChanges: (changeSet?.rollbackUnsafeFiles?.length ?? 0) === 0,
      setActivityView,
      setBottomView,
      openSymbols: () => setPaletteMode("symbols"),
      openDocTab: (kind) => useTabStore.getState().openDoc(kind),
      runAllVerifications: () => void runVerifications(verificationCommands),
      rerunVerification: () => void runVerifications(verificationCommands),
      rollbackTask: () => void rollbackTask(),
      newTask: beginNewTask,
      commitChanges: () => void commitChanges(),
      explain: requestExplanation,
      generateComments,
      toggleBottom: () => toggleBottom(),
      openGoToDefinition,
      openFindReferences,
      openImpactAnalysis,
      rebuildIndex: () => void rebuildIndex(),
      indexReady,
    }),
    [
      commitChanges,
      activeFileTab,
      beginNewTask,
      changeSet?.baselineMode,
      changeSet?.rollbackUnsafeFiles?.length,
      cwd,
      verificationCommands,
      indexReady,
      generateComments,
      openFindReferences,
      openGoToDefinition,
      openImpactAnalysis,
      combinedProblems.length,
      rebuildIndex,
      requestExplanation,
      rollbackTask,
      runVerifications,
      setActivityView,
      setBottomView,
      streaming,
      task,
      taskChangeCount,
      toggleBottom,
    ],
  );

  const commands = useMemo(() => buildCommands(commandContext), [commandContext]);

  const openPaletteRef = useRef(setPaletteMode);
  openPaletteRef.current = setPaletteMode;

  /**
   * Bootstrap the workspace symbol index. Pulls initial status, then mirrors
   * `coding://index-updated` / `coding://index-removed` into local state so the
   * command palette can grey out workbench commands until the index is ready.
   */
  useEffect(() => {
    if (!cwd) {
      setIndexStatus(null);
      return;
    }
    let cancelled = false;
    let watcherAcquired = false;
    const client = getSymbolIndexClient(cwd);
    void codingApi.indexBootstrap(cwd).then((status) => {
      watcherAcquired = true;
      if (cancelled) {
        void codingApi.indexRelease(cwd).catch(() => undefined);
        return;
      }
      if (!cancelled && status) setIndexStatus(status);
      return client.refresh();
    }).catch(() => undefined);
    const unsubUpdated = client.subscribe(() => {
      if (cancelled) return;
      setWorkspaceSymbols(client.symbols().map((symbol) => ({
        name: symbol.name,
        detail: symbol.signature ?? symbol.kind,
        path: symbol.file,
        line: symbol.line,
      })));
      void codingApi.indexStatus(cwd).then((status) => {
        if (!cancelled && status) setIndexStatus(status);
      }).catch(() => undefined);
    });
    return () => {
      cancelled = true;
      unsubUpdated();
      if (watcherAcquired) void codingApi.indexRelease(cwd).catch(() => undefined);
    };
  }, [cwd]);

  /**
   * Workbench shortcuts. The palette uses ⌘⇧P rather than ⌘K because the
   * application already binds ⌘K to global session search in App.tsx, and the
   * workbench must not repurpose an existing app-level shortcut.
   */
  useEffect(() => {
    if (!cwd) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (isGlobalShortcutBlocked()) return;
      const lower = event.key.toLowerCase();
      const target = event.target as HTMLElement | null;
      const inEditable =
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLInputElement ||
        (target instanceof HTMLElement && target.isContentEditable);

      // F2: rename primary selected node (only one selected, single no-modifier press).
      if (
        !inEditable
        && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
        && !event.repeat
        && lower === "f2"
      ) {
        const sel = useFileTreeSelectionStore.getState().selectedPaths;
        if (sel.size === 1) {
          event.preventDefault();
          event.stopPropagation();
          setRenamingPath([...sel][0]);
        }
        return;
      }

      // Delete / Backspace: delete selected entries.
      if (
        !inEditable
        && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
        && !event.repeat
        && (lower === "delete" || lower === "backspace")
      ) {
        const sel = useFileTreeSelectionStore.getState().selectedPaths;
        if (sel.size > 0) {
          event.preventDefault();
          event.stopPropagation();
          void confirmDelete([...sel]);
        }
        return;
      }

      // Cmd+C / Cmd+X / Cmd+V: clipboard.
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.repeat) {
        if (lower === "c" && !event.shiftKey && !inEditable) {
          const sel = [...useFileTreeSelectionStore.getState().selectedPaths];
          if (sel.length > 0) {
            event.preventDefault();
            event.stopPropagation();
            useClipboardStore.getState().setCopy(sel);
            onToast?.(`已复制 ${sel.length} 个条目`);
          }
          return;
        }
        // SP4: ⌘⇧E / ⌘⇧R / ⌘⇧T / ⌘⇧F — AI quick actions.
        if (event.shiftKey) {
          // Editors and form fields own their native Shift shortcuts.
          if (inEditable) return;
          const sel = [...useFileTreeSelectionStore.getState().selectedPaths];
          const noSelection = () => onToast?.("请先在文件树中选中文件");
          const dispatch = (): boolean => {
            if (sel.length === 0) {
              noSelection();
              return false;
            }
            event.preventDefault();
            event.stopPropagation();
            return true;
          };
          switch (lower) {
            case "e":
              if (!dispatch()) return;
              void startTask(
                `请基于真实代码解释 ${sel.join(", ")} 的职责、关键数据流、依赖关系、边界条件、业务规则与潜在风险。只分析，不修改文件。`,
                undefined,
              );
              return;
            case "r":
              if (!dispatch()) return;
              void requestReview(sel);
              return;
            case "t":
              if (!dispatch()) return;
              void requestTests(sel);
              return;
            case "f":
              if (!dispatch()) return;
              void requestRefactor(sel);
              return;
            default:
              break;
          }
        }
        if (lower === "x" && !event.shiftKey && !inEditable) {
          const sel = [...useFileTreeSelectionStore.getState().selectedPaths];
          if (sel.length > 0) {
            event.preventDefault();
            event.stopPropagation();
            useClipboardStore.getState().setCut(sel);
            onToast?.(`已剪切 ${sel.length} 个条目`);
          }
          return;
        }
        if (lower === "v" && !event.shiftKey && !inEditable) {
          const cb = useClipboardStore.getState();
          if (cb.paths.length > 0) {
            event.preventDefault();
            event.stopPropagation();
            const dest = selectedDirectory || cwd;
            void performPaste(dest);
          }
          return;
        }
      }

      // SP5: ⌘Z / ⌘⇧Z — undo / redo. Don't intercept inside editable fields
      // so Monaco / Composer textarea get the browser's native undo for free.
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.repeat) {
        if (!inEditable) {
          const undoKey = event.key.toLowerCase();
          if (undoKey === "z" && !event.shiftKey) {
            event.preventDefault();
            event.stopPropagation();
            void performHistoryAction("undo");
            return;
          }
          if (undoKey === "z" && event.shiftKey) {
            event.preventDefault();
            event.stopPropagation();
            void performHistoryAction("redo");
            return;
          }
        }
      }

      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.repeat) return;
      const key = event.key.toLowerCase();
      if (key === "p" && event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        openPaletteRef.current("commands");
      } else if (key === "p") {
        event.preventDefault();
        event.stopPropagation();
        openPaletteRef.current("files");
      } else if (key === "t") {
        event.preventDefault();
        event.stopPropagation();
        openPaletteRef.current("symbols");
      } else if (key === "j") {
        event.preventDefault();
        event.stopPropagation();
        toggleBottom();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [
    confirmDelete,
    cwd,
    onToast,
    performHistoryAction,
    performPaste,
    selectedDirectory,
    toggleBottom,
  ]);

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

  if (!window.location.search.includes("legacy-coding")) return (
    <div ref={workbenchRef} className="coding-workbench coding-workbench--theia" style={style}>
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
            dirtyCount={dirtyFileCount}
            onSelect={switchProject}
            onRemove={removeRecentProject}
            onOpenFolder={openAnotherProject}
          />
        </div>
        <form className="echo-theia-preview-form" onSubmit={(event) => {
          event.preventDefault();
          const raw = theiaPreviewInput.trim();
          if (!raw) return;
          try {
            const url = new URL(raw.startsWith("http://") || raw.startsWith("https://") ? raw : `http://${raw}`);
            setTheiaPreviewRequest({ url: url.toString(), id: Date.now() });
          } catch {
            onToast?.("请输入有效的预览地址，例如 localhost:5173");
          }
        }}>
          <input
            aria-label="网页预览地址"
            placeholder="localhost:5173"
            value={theiaPreviewInput}
            onChange={(event) => setTheiaPreviewInput(event.target.value)}
          />
          <button type="submit">预览</button>
        </form>
        <div className="coding-workbench__topbar-right" data-tauri-drag-region>
          <button type="button" className="coding-icon-btn" onClick={onOpenSettings} aria-label="设置">
            <Settings2 size={15} />
          </button>
        </div>
      </header>

      <main className="echo-theia-workspace">
        <TheiaIdeFrame
          root={cwd}
          onBeforeMutation={beforeTheiaMutation}
          onAfterMutation={afterTheiaMutation}
          onActiveFile={setTheiaActiveFile}
          onToast={onToast}
          previewRequest={theiaPreviewRequest}
        />
        {theiaReviewPath && task && (
          <TheiaTaskReview
            root={cwd}
            taskId={task.id}
            path={theiaReviewPath}
            onClose={() => setTheiaReviewPath(null)}
            onReviewed={async () => {
              await useTaskStore.getState().refreshTaskState();
              setReportRevision((value) => value + 1);
            }}
            onToast={onToast}
          />
        )}
      </main>

      <div
        className="coding-workbench__vsplit echo-theia-agent__splitter"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整 Agent 面板宽度"
        tabIndex={0}
        onPointerDown={startAgentDrag}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft") setAgentWidth(effectiveLayout.agentWidth + 16);
          if (event.key === "ArrowRight") setAgentWidth(effectiveLayout.agentWidth - 16);
        }}
      />

      <aside className="echo-theia-agent" aria-label="Coding Agent">
        <div className="coding-agent__taskbar">
          <span>开发任务</span>
          <TaskSwitcher
            tasks={summaries}
            activeId={task?.id}
            newDisabled={activeTaskCount > 0}
            onSelect={(taskId) => void activateCodingTask(taskId)}
            onNew={beginNewTask}
            onRename={renameCodingTask}
            onDelete={deleteCodingTask}
          />
        </div>
        <div className="echo-theia-agent__tabs" role="tablist" aria-label="开发任务面板">
          <button type="button" role="tab" aria-selected={theiaPanel === "agent"} onClick={() => setTheiaPanel("agent")}>Agent</button>
          <button type="button" role="tab" aria-selected={theiaPanel === "changes"} onClick={() => setTheiaPanel("changes")}>变更 {taskChangeCount || ""}</button>
          <button type="button" role="tab" aria-selected={theiaPanel === "verification"} onClick={() => setTheiaPanel("verification")}>验证</button>
        </div>
        {theiaActiveFile && (
          <div className="echo-theia-agent__context">
            <span title={theiaActiveFile}>{workspaceRelativePath(cwd, theiaActiveFile)}</span>
            <button type="button" onClick={() => addManyToContext([theiaActiveFile])}>加入上下文</button>
          </div>
        )}
        <div className="echo-theia-agent__content">
          {theiaPanel === "agent" && (task ? (
            <AgentPane
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
              onOpenReport={() => setTheiaPanel("changes")}
              onToast={onToast}
              onPathsDropped={(paths) => addManyToContext(paths)}
            />
          ) : (
            <TaskStarter
              models={models}
              workspaceRoot={cwd}
              modelId={modelId}
              onModelChange={(next) => void changeTaskModel(next)}
              starting={starting}
              error={startError}
              apiReady={apiReady}
              contextPaths={contextPaths}
              onStart={(requirement) => void startTask(requirement)}
              onDraftContextPaths={addManyToContext}
              onOpenSettings={onOpenSettings}
              onToast={onToast}
            />
          ))}
          {theiaPanel === "changes" && (
            <ChangeSetView
              changeSet={changeSet}
              hasTask={Boolean(task)}
              busyPath={busyPath ?? diffLoadingPath}
              committing={committing}
              canCommit={task?.phase === "delivered" && !changeSet?.committedHash}
              canRollback={!changeSet?.committedHash && !runningVerification && !streaming
                && Boolean(task && ["paused", "stopped", "delivered", "blocked"].includes(task.phase))}
              canDiscard={!runningVerification && !streaming && !sending
                && Boolean(task && ["implementing", "repairing", "discovering", "paused", "stopped", "blocked", "delivered"].includes(task.phase))}
              onOpenDiff={(change) => setTheiaReviewPath(change.path)}
              onDiscard={(change) => void discardChange(change.path)}
              onCommit={() => void commitChanges()}
              onRollback={() => void rollbackTask()}
            />
          )}
          {theiaPanel === "verification" && (
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
              {theiaVerificationOutput && <pre className="echo-theia-agent__output">{theiaVerificationOutput}</pre>}
            </>
          )}
        </div>
      </aside>
      {taskDialog}
    </div>
  );

  return (
    <div
      ref={workbenchRef}
      className={`coding-workbench${bottomOpen ? " is-bottom-open" : ""}`}
      style={style}
    >
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
          <span className="coding-workbench__topbar-separator" aria-hidden="true" />
          <ProjectSwitcher
            projects={recentCodingProjects}
            activeCwd={activeCodingWorkspaceCwd || cwd}
            dirtyCount={dirtyFileCount}
            onSelect={switchProject}
            onRemove={removeRecentProject}
            onOpenFolder={openAnotherProject}
          />
        </div>
        <button
          type="button"
          className="coding-workbench__palette-btn"
          onClick={() => setPaletteMode("commands")}
          aria-label="打开命令面板"
          title={`命令面板 ${shortcutLabel("⌘⇧P", "Ctrl+Shift+P")}`}
        >
          <Search size={13} />
          <span>搜索命令与文件</span>
          <kbd>{shortcutLabel("⌘⇧P", "Ctrl+Shift+P")}</kbd>
        </button>
        <div className="coding-workbench__topbar-right" data-tauri-drag-region>
          <button
            type="button"
            className="coding-icon-btn"
            onClick={onOpenSettings}
            aria-label="设置"
          >
            <Settings2 size={15} />
          </button>
        </div>
      </header>

      <div className="coding-workbench__activity">
        <ActivityBar
          active={activityView === "symbols" ? "files" : activityView}
          onChange={setActivityView}
          changeCount={taskChangeCount}
          contextCount={contextPaths.length}
        />
      </div>

      <aside className="coding-workbench__explorer" aria-label="资源管理器">
        {activityView === "files" && (
          <FileExplorerView
            root={cwd}
            tabs={tabs}
            activeId={activeTabId}
            symbols={symbols}
            activeFileName={activeRelativePath}
            showHidden={showHidden}
            filter={explorerFilter}
            onFilterChange={setExplorerFilter}
            onSelectTab={(id) => useTabStore.getState().setActive(id)}
            onCloseTab={closeTabSafely}
            onOpenSymbol={(symbol) => {
              void openFile(symbol.path);
              setReveal({ line: symbol.line, column: 1, key: Date.now() });
            }}
            onNewFile={() => void createWorkspaceEntry(false)}
            onNewDirectory={() => void createWorkspaceEntry(true)}
            onRefresh={() => {
              setTreeRefresh((current) => ({ revision: current.revision + 1, paths: [] }));
              void useGitSnapshotStore.getState().refresh(cwd);
            }}
            onCollapseAll={() => setTreeCollapseKey((value) => value + 1)}
            onRevealActive={() => {
              if (!activeFileTab) return;
              setTreeReveal((current) => ({ path: activeFileTab.id, key: current.key + 1 }));
            }}
            onToggleHidden={() => setShowHidden(!showHidden)}
            fileTree={(
              <FileTreeView
                key={cwd}
                rootPath={cwd}
                selectedPath={activeFileTab?.id}
                selectedDirectoryPath={selectedDirectory}
                onFileSelect={(path) => void openFile(path)}
                onDirectorySelect={setSelectedDirectory}
                onToast={onToast}
                refreshKey={treeRefresh.revision}
                refreshPaths={treeRefresh.paths}
                collapseKey={treeCollapseKey}
                revealPath={treeReveal.path}
                revealKey={treeReveal.key}
                initialExpandedPaths={treeExpandedPathsRef.current.get(cwd) ?? []}
                onExpandedPathsChange={(paths) => {
                  treeExpandedPathsRef.current.set(cwd, paths);
                  setTreePersistenceRevision((value) => value + 1);
                }}
                cutPaths={cutPaths}
                onContextMenu={handleFileTreeContextMenu}
                renamingPath={renamingPath}
                onRenameSubmit={performRename}
                onRenameCancel={() => setRenamingPath(null)}
                includeHidden={showHidden}
                gitStatusByPath={gitStatusByPath}
                filter={explorerFilter}
                indexedPaths={filePaths}
                onSelectDirectory={openAnotherProject}
              />
            )}
          />
        )}
        {activityView !== "files" && (
          <div className="coding-explorer__heading">
            <span>{EXPLORER_TITLES[activityView]}</span>
          </div>
        )}
        {contextMenu && (
          <FileTreeContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            items={buildContextMenuItems(contextMenu)}
            onClose={() => setContextMenu(null)}
            onError={(error) => {
              const message = String(error).replace(/^Error:\s*/, "");
              onToast?.(`操作失败：${message}`);
            }}
            ariaLabel="文件操作"
          />
        )}
        {activityView === "search" && (
          <SearchView
            root={cwd}
            busy={replacing}
            onOpenHit={(hit) => {
              void openFile(workspaceFilePath(cwd, hit.path));
              setReveal({ line: hit.line, column: hit.column, key: Date.now() });
            }}
            onReplaceAll={replaceAcrossHits}
          />
        )}
        {activityView === "changes" && (
          <ChangeSetView
            changeSet={changeSet}
            hasTask={Boolean(task)}
            busyPath={busyPath ?? diffLoadingPath}
            committing={committing}
            canCommit={
              task?.phase === "delivered"
              && !changeSet?.committedHash
            }
            canRollback={
              !changeSet?.committedHash
              && !runningVerification
              && !streaming
              && Boolean(task && ["paused", "stopped", "delivered", "blocked"].includes(task.phase))
            }
            canDiscard={
              !runningVerification
              && !streaming
              && !sending
              && Boolean(task && [
                "implementing",
                "repairing",
                "discovering",
                "paused",
                "stopped",
                "blocked",
                "delivered",
              ].includes(task.phase))
            }
            onOpenDiff={(change) => void openTaskDiff(change.path)}
            onDiscard={(change) => void discardChange(change.path)}
            onCommit={() => void commitChanges()}
            onRollback={() => void rollbackTask()}
          />
        )}
        {activityView === "symbols" && (
          <SymbolView
            symbols={symbols}
            activeFileName={activeRelativePath}
            root={cwd}
            onOpenSymbol={(symbol) => {
              void openFile(symbol.path);
              setReveal({ line: symbol.line, column: 1, key: Date.now() });
            }}
          />
        )}
        {activityView === "context" && (
          <ContextPackView
            paths={contextPaths}
            scopeLabel={task ? `任务“${task.name}”的` : "新任务"}
            activePath={activeRelativePath}
            onAdd={(path) => addManyToContext([path])}
            onRemove={removeFromContext}
            onClear={clearContext}
          />
        )}
      </aside>

      <div
        className="coding-workbench__vsplit coding-workbench__vsplit--explorer"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整资源管理器宽度"
        tabIndex={0}
        onPointerDown={startExplorerDrag}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft") setExplorerWidth(effectiveLayout.explorerWidth - 16);
          if (event.key === "ArrowRight") setExplorerWidth(effectiveLayout.explorerWidth + 16);
        }}
      />

      <main className="coding-workbench__main">
        <TabContainer
          tabs={tabs}
          activeId={activeTabId}
          reveal={reveal}
          onSelect={(id) => useTabStore.getState().setActive(id)}
          onClose={closeTabSafely}
          onDraftChange={(id, draft) => useTabStore.getState().updateDraft(id, draft)}
          onSave={(id) => void saveFile(id)}
          minimapEnabled={
            (cwd ? workspaceUiStateRef.current.get(cwd)?.minimapEnabled : undefined)
              ?? DEFAULT_MINIMAP_ENABLED
          }
          onMinimapEnabledChange={(next) => {
            if (!cwd) return;
            const key = cwd;
            const current = workspaceUiStateRef.current.get(key) ?? {
              tabs: [],
              activeId: null,
              contextPaths: [],
              editorContext: null,
              selectedDirectory: cwd,
              minimapEnabled: DEFAULT_MINIMAP_ENABLED,
            };
            workspaceUiStateRef.current.set(key, { ...current, minimapEnabled: next });
            setUiStateRevision((value) => value + 1);
          }}
          onCursorChange={setCursor}
          onLanguageChange={(info) => {
            setLanguageId(info.language);
            setEol(info.eol);
            setIndent(info.indent);
          }}
          onEditorReady={(editor) => {
            editorRef.current = editor;
          }}
          onBreadcrumbSelect={(directoryPath) => {
            setSelectedDirectory(directoryPath);
            setActivityView("files");
            setExplorerFilter("");
            setTreeReveal((current) => ({ path: directoryPath, key: current.key + 1 }));
          }}
          onViewChange={handleFileViewChange}
          viewBusy={Boolean(
            activeFileTab
            && diffLoadingPath === workspaceRelativePath(cwd, activeFileTab.relativePath),
          )}
          reviewBusy={Boolean(activeFileTab && reviewingPath === activeFileTab.relativePath)}
          reviewedPath={activeFileTab && changeSet?.reviewedFiles.includes(activeFileTab.relativePath)
            ? activeFileTab.relativePath
            : undefined}
          onMarkReviewed={markTaskDiffReviewed}
          onReload={(id) => void reloadFile(id)}
          onSymbolAction={(action, symbol) => {
            const key = { name: symbol, file: activeRelativePath };
            if (action === "definition") openGoToDefinition(key);
            else if (action === "references") openFindReferences(key);
            else openImpactAnalysis(key);
          }}
          onSymbols={(path, list) =>
            setSymbolsByPath((current) => ({
              ...current,
              [path]: list.map((symbol) => ({ ...symbol, path })),
            }))
          }
          onDiagnostics={(path, diagnostics) =>
            setEditorDiagnostics((current) => ({ ...current, [path]: diagnostics }))
          }
          onEditorContext={setEditorContext}
          onGenerateDocumentation={(context) => void generateComments(context)}
          renderDoc={(kind) => {
            const openRelative = (path: string) => void openFile(workspaceFilePath(cwd, path));
            if (kind === "delivery") {
              return (
                <DeliveryReportTab
                  root={cwd}
                  taskId={task?.id ?? null}
                  revision={reportRevision}
                  onOpenFile={(path) => void openTaskDiff(path)}
                  onToast={onToast}
                />
              );
            }
            if (kind === "taskDag") {
              return (
                <TaskDagTab
                  task={task}
                  repairRounds={orchestrator?.repairRounds ?? []}
                  maxRepairRounds={orchestrator?.maxRepairRounds ?? 3}
                  changedFileCount={taskChangeCount}
                  problemCount={problems.length}
                  ledger={ledger}
                  onOpenFile={openRelative}
                />
              );
            }
            return <ProjectProfileTab root={cwd} onOpenFile={openRelative} />;
          }}
          renderVirtual={(tab) => {
            const handleJump = (target: { path: string; line: number; name?: string }) => jumpToSymbol(target);
            if (tab.kind === "findReferences") {
              return (
                <FindReferencesView
                  root={tab.root}
                  symbol={tab.symbol.name}
                  onOpenSymbol={handleJump}
                />
              );
            }
            if (tab.kind === "impactAnalysis") {
              return (
                <ImpactAnalysisView
                  root={tab.root}
                  symbol={tab.symbol.name}
                  onOpenSymbol={handleJump}
                />
              );
            }
            return (
              <GoToDefinitionView
                root={tab.root}
                symbol={tab.symbol.name}
                onJump={handleJump}
                onOpenSymbol={handleJump}
                onClose={() => useTabStore.getState().closeTab(tab.id)}
              />
            );
          }}
        />
      </main>

      <div
        className="coding-workbench__vsplit coding-workbench__vsplit--agent"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整 Agent 面板宽度"
        tabIndex={0}
        onPointerDown={startAgentDrag}
        onKeyDown={(event) => {
          // The Agent pane grows leftwards, so the arrows are mirrored.
          if (event.key === "ArrowLeft") setAgentWidth(effectiveLayout.agentWidth + 16);
          if (event.key === "ArrowRight") setAgentWidth(effectiveLayout.agentWidth - 16);
        }}
      />

      <aside className="coding-workbench__agent" aria-label="Agent 面板">
        <div className="coding-agent__taskbar">
          <span>开发任务</span>
          <TaskSwitcher
            tasks={summaries}
            activeId={task?.id}
            newDisabled={activeTaskCount > 0}
            onSelect={(taskId) => void activateCodingTask(taskId)}
            onNew={beginNewTask}
            onRename={renameCodingTask}
            onDelete={deleteCodingTask}
          />
        </div>
        {task ? (
          <AgentPane
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
            onOpenChanges={() => setActivityView("changes")}
            onOpenReport={() => useTabStore.getState().openDoc("delivery")}
            onToast={onToast}
            onPathsDropped={(paths) => {
              addManyToContext(paths);
              onToast?.(`已添加 ${paths.length} 个文件到上下文`);
            }}
          />
        ) : (
          <TaskStarter
            models={models}
            workspaceRoot={cwd}
            modelId={modelId}
            onModelChange={(next) => void changeTaskModel(next)}
            starting={starting}
            error={startError}
            apiReady={apiReady}
            contextPaths={contextPaths}
            onStart={(requirement) => void startTask(requirement)}
            onDraftContextPaths={addManyToContext}
            onOpenSettings={onOpenSettings}
            onToast={onToast}
          />
        )}
      </aside>

      {bottomOpen && (
        <BottomPanel
          root={cwd}
          view={bottomView}
          height={effectiveLayout.bottomHeight}
          onViewChange={setBottomView}
          onCollapse={() => toggleBottom(false)}
          onResize={setBottomHeight}
          problems={combinedProblems}
          records={verifications}
          detected={verificationCommands}
          running={runningVerification}
          hasTask={Boolean(task)}
          output={commandOutput}
          messages={messages}
          terminalActivated={terminalActivated}
          onActivateTerminal={() => setTerminalActivated(true)}
          onOpenProblem={openProblem}
          onRun={(command) => void runVerifications([command])}
          onRunAll={() => void runVerifications(verificationCommands)}
          onCancelVerification={() => {
            if (activeRunId) void codingApi.cancelVerification(activeRunId);
          }}
          onOpenVerificationOutput={(record) =>
            setCommandOutput([record.stdout, record.stderr].filter(Boolean).join("\n"))
          }
          onClearOutput={() => setCommandOutput("")}
          onToast={onToast}
        />
      )}

      <FooterStatusBar
        cursor={cursor}
        eol={eol}
        language={languageId}
        indent={indent}
        editorEditable={Boolean(activeFileTab && activeFileTab.view === "edit" && !activeFileTab.loading && !activeFileTab.error)}
        onEolChange={(next) => {
          const editor = editorRef.current;
          const model = editor?.getModel();
          if (model) model.setEOL(next === "CRLF" ? MonacoEditor.EndOfLineSequence.CRLF : MonacoEditor.EndOfLineSequence.LF);
          setEol(next);
        }}
        onIndentChange={(next) => {
          const model = editorRef.current?.getModel();
          if (!model) return;
          model.updateOptions({
            tabSize: next.size,
            insertSpaces: next.kind === "space",
          });
          setIndent(next);
        }}
        onLanguageChange={(next) => {
          const model = editorRef.current?.getModel();
          if (!model) return;
          MonacoEditor.setModelLanguage(model, next);
          if (activeFileTab) useTabStore.getState().setLanguage(activeFileTab.id, next);
          setLanguageId(next);
        }}
        onOpenProblems={() => setBottomView("problems")}
        taskSummary={
          task
            ? statusSummary({
                phase: task.phase,
                changedFileCount: taskChangeCount,
                problemCount: combinedProblems.length,
                repairRound: orchestrator?.repairRounds.length,
                maxRepairRounds: orchestrator?.maxRepairRounds,
              })
            : "就绪"
        }
        problemCount={combinedProblems.length}
        indexing={indexing}
        changeSetMode={
          changeSet
            ? changeSet.baselineMode === "filesystem"
              ? "filesystem"
              : "git"
            : "ready"
        }
      />

      {paletteMode && (
        <CommandPalette
          mode={paletteMode}
          commands={commands}
          paths={filePaths}
          symbols={workspaceSymbols.length > 0 ? workspaceSymbols : symbols}
          pathsLoading={indexing}
          onClose={() => setPaletteMode(null)}
          onModeChange={setPaletteMode}
          onOpenPath={(path) => void openFile(workspaceFilePath(cwd, path))}
          onOpenSymbol={(symbol) => {
            void openFile(symbol.path);
            setReveal({ line: symbol.line, column: 1, key: Date.now() });
          }}
        />
      )}
      {taskDialog}
    </div>
  );
}
