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
  FilePlus2,
  FolderGit2,
  FolderOpen,
  FolderPlus,
  Search,
  Settings2,
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
  type CodingSearchHit,
} from "@/lib/agent-client";
import { isGlobalShortcutBlocked } from "@/lib/keyboard-scope";
import "@/styles/coding-workbench.css";

import { AgentPane } from "./agent/AgentPane";
import { TaskStarter } from "./agent/TaskStarter";
import { ChangeSetView } from "./explorer/ChangeSetView";
import { ContextPackView } from "./explorer/ContextPackView";
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
import { DeliveryReportTab } from "./main/docs/DeliveryReportTab";
import { ProjectProfileTab } from "./main/docs/ProjectProfileTab";
import { TaskDagTab } from "./main/docs/TaskDagTab";
import { BottomPanel } from "./panels/BottomPanel";
import { TabContainer } from "./main/TabContainer";
import { ActivityBar } from "./shell/ActivityBar";
import { CommandPalette, type PaletteMode, type PaletteSymbol } from "./shell/CommandPalette";
import { TaskSwitcher } from "./shell/TaskSwitcher";
import { isFileTab, useTabStore, type SymbolKey } from "./store/tab-store";
import { useTaskStore } from "./store/task-store";
import { fitWorkbenchLayout, useWorkbenchStore } from "./store/workbench-store";

interface CodingWorkbenchProps {
  cwd?: string;
  workspaces?: { cwd: string }[];
  onSelectWorkspace?: (cwd: string) => void;
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
  changes: "变更集",
  symbols: "符号",
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

  const tabs = useTabStore((state) => state.tabs);
  const activeTabId = useTabStore((state) => state.activeId);

  const [selectedDirectory, setSelectedDirectory] = useState(cwd);
  const [paletteMode, setPaletteMode] = useState<PaletteMode | null>(null);
  const [filePaths, setFilePaths] = useState<string[]>([]);
  const [indexing, setIndexing] = useState(false);
  const [symbolsByPath, setSymbolsByPath] = useState<Record<string, PaletteSymbol[]>>({});
  const [workspaceSymbols, setWorkspaceSymbols] = useState<PaletteSymbol[]>([]);
  const [editorContext, setEditorContext] = useState<EditorCodeContext | null>(null);
  const [reveal, setReveal] = useState<{ line: number; column: number; key: number }>();
  const [indexStatus, setIndexStatus] = useState<IndexStatus | null>(null);
  const indexReady = indexStatus?.state === "ready";
  const [contextPaths, setContextPaths] = useState<string[]>([]);
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
  /** Bumped whenever the task's evidence changes, so an open report reloads. */
  const [reportRevision, setReportRevision] = useState(0);
  const repairPromptRef = useRef<string | null>(null);
  const workflowActionRef = useRef<string | null>(null);
  const pendingTreePathsRef = useRef(new Set<string>());
  const treeRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileIndexEventsRef = useRef(new Map<string, boolean>());
  const diffRequestGenerationRef = useRef(new Map<string, number>());
  const diffTaskRef = useRef<string | null>(null);
  const workbenchRef = useRef<HTMLDivElement>(null);
  const workbenchSize = useElementSize(workbenchRef);

  const queueTreeRefresh = useCallback((changedPath: string) => {
    const relativePath = workspaceRelativePath(cwd, changedPath);
    pendingTreePathsRef.current.add(relativePath);
    if (treeRefreshTimerRef.current !== null) return;
    treeRefreshTimerRef.current = setTimeout(() => {
      treeRefreshTimerRef.current = null;
      const paths = [...pendingTreePathsRef.current];
      pendingTreePathsRef.current.clear();
      setTreeRefresh((current) => ({ revision: current.revision + 1, paths }));
    }, 80);
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

  /** Load a file into a tab, reusing the tab if it is already open. */
  const openFile = useCallback(
    async (absolutePath: string) => {
      const store = useTabStore.getState();
      const existing = store.tabs.find((tab) => tab.id === absolutePath);
      if (existing) {
        store.setActive(absolutePath);
        return;
      }
      const name = basename(absolutePath);
      store.openFile({
        id: absolutePath,
        relativePath: absolutePath,
        name,
        language: "plaintext",
        original: "",
        draft: "",
        hash: "",
        loading: true,
      });
      try {
        const document = await codingReadDocument(cwd, absolutePath);
        const current = useTabStore.getState();
        // The tab may have been closed while the read was in flight.
        if (!current.tabs.some((tab) => tab.id === absolutePath)) return;
        current.closeTab(absolutePath);
        current.openFile({
          id: absolutePath,
          relativePath: document.relativePath,
          name,
          language: document.language,
          original: document.content,
          draft: document.content,
          hash: document.hash,
          loading: false,
        });
      } catch (error) {
        useTabStore
          .getState()
          .setError(absolutePath, `打开失败：${String(error).replace(/^Error:\s*/, "")}`);
      }
    },
    [cwd],
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

  const reloadFile = useCallback(async (id: string) => {
    try {
      const document = await codingReadDocument(cwd, id);
      useTabStore.getState().markSaved(id, document.content, document.hash);
      onToast?.(`已重新加载 ${basename(id)}`);
    } catch (error) {
      onToast?.(`重新加载失败：${String(error).replace(/^Error:\s*/, "")}`);
    }
  }, [cwd, onToast]);

  const closeTabSafely = useCallback((id: string) => {
    const tab = useTabStore.getState().tabs.find((entry) => entry.id === id);
    if (tab && isFileTab(tab) && tab.draft !== tab.original) {
      if (!window.confirm(`${tab.name} 有未保存修改，确认放弃并关闭？`)) return;
    }
    useTabStore.getState().closeTab(id);
  }, []);

  const exitSafely = useCallback(() => {
    const dirtyCount = useTabStore.getState().tabs.filter(
      (tab) => isFileTab(tab) && tab.draft !== tab.original,
    ).length;
    if (dirtyCount > 0 && !window.confirm(`有 ${dirtyCount} 个文件尚未保存，确认离开代码开发？`)) {
      return;
    }
    onExit?.();
  }, [onExit]);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      const dirty = useTabStore.getState().tabs.some(
        (tab) => isFileTab(tab) && tab.draft !== tab.original,
      );
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, []);

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
    async (query: string, replacement: string, hits: CodingSearchHit[]) => {
      const uniquePaths = [...new Set(hits.map((hit) => hit.path))];
      const caseSensitive = query !== query.toLowerCase();
      const plans: Array<{ path: string; count: number; content: string; hash: string }> = [];
      for (const relative of uniquePaths) {
        try {
          const document = await codingReadDocument(cwd, workspaceFilePath(cwd, relative));
          const count = countOccurrences(document.content, query, caseSensitive);
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
      if (!window.confirm(`${summary}。确认执行？`)) return;

      const mutation = await prepareManualMutation();
      if (!mutation) return;

      setReplacing(true);
      let changed = 0;
      let skipped = 0;
      let writeFailures = 0;
      try {
        for (const plan of plans) {
          const next = replaceAll(plan.content, query, replacement, caseSensitive);
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
      cwd,
      finishManualMutation,
      onToast,
      prepareManualMutation,
    ],
  );

  // Close every tab when the workspace changes; their paths no longer apply.
  useEffect(() => {
    useTabStore.getState().closeAll();
    setSymbolsByPath({});
    setWorkspaceSymbols([]);
    setEditorContext(null);
    setContextPaths([]);
  }, [cwd]);

  useEffect(() => {
    hydrateLayout();
  }, [hydrateLayout]);

  useEffect(() => setSelectedDirectory(cwd), [cwd]);

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

  const createWorkspaceEntry = useCallback(async (directory: boolean) => {
    const name = window.prompt(directory ? "新目录名称" : "新文件名称");
    if (!name?.trim()) return;
    const mutation = directory ? { taskId: null, closeRound: false } : await prepareManualMutation();
    if (!mutation) return;
    let createdFile = false;
    try {
      const created = await codingApi.createEntry(cwd, selectedDirectory || cwd, name.trim(), directory);
      createdFile = !directory;
      queueTreeRefresh(created);
      if (!directory) recordFileIndexEvent(created, false);
      if (!directory) await openFile(created);
      if (!directory) await finishManualMutation(mutation);
      onToast?.(`已创建${directory ? "目录" : "文件"} ${name.trim()}`);
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
    selectedDirectory,
  ]);

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
    async (requirement: string, documentationTarget?: EditorCodeContext) => {
      if (!cwd || !onStartRun) return;
      setStarting(true);
      setStartError(null);
      let createdId: string | undefined;
      try {
        const documentation = isDocumentationRequest(requirement)
          ? await resolveDocumentationWorkflow(requirement, documentationTarget)
          : undefined;
        const effectiveContextPaths = [...new Set([
          ...contextPaths,
          ...(documentation?.request.target?.path ? [documentation.request.target.path] : []),
        ])];
        const managedPrompt = documentation
          ? buildCodingWorkflowPrompt(
              requirement,
              effectiveContextPaths,
              false,
              { documentation },
            )
          : undefined;
        const created = await useTaskStore.getState().createTask(deriveName(requirement), requirement);
        if (!created) {
          setStartError(useTaskStore.getState().error ?? "创建任务失败");
          return;
        }
        createdId = created.id;
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
              requirement,
              modelId,
              effectiveContextPaths,
              bindSession,
              managedPrompt,
            )
          : await onStartRun(
              cwd,
              requirement,
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
        const promptTextOverride = managedPrompt ?? (task
          ? buildCodingWorkflowPrompt(
              text,
              documentationPaths,
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
      cwd,
      hostSessionId,
      onSendMessage,
      onToast,
      resolveDocumentationWorkflow,
      task,
    ],
  );

  const activateCodingTask = useCallback(async (taskId: string) => {
    setSending(true);
    try {
      await useTaskStore.getState().selectTask(taskId);
      const selected = useTaskStore.getState().task;
      if (selected?.sessionId) {
        await onActivateSession?.(selected.sessionId, cwd);
        if (selected.modelId) setModelId(selected.modelId);
      }
    } catch (error) {
      onToast?.(`恢复任务会话失败：${String(error).replace(/^Error:\s*/, "")}`);
    } finally {
      setSending(false);
    }
  }, [cwd, onActivateSession, onToast]);

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
    if (
      !window.confirm(
        `将把 ${count} 个任务相关文件精确恢复到任务开始时的内容。已提交的任务不能回滚。确认继续？`,
      )
    ) {
      return;
    }
    try {
      const restored = await codingApi.rollbackTask(cwd, task.id);
      await useTaskStore.getState().refreshTaskState();
      useTabStore.getState().closeAll();
      onToast?.(`已回滚 ${restored.length} 个文件`);
    } catch (error) {
      onToast?.(`回滚失败：${String(error).replace(/^Error:\s*/, "")}`);
    }
  }, [changeSet?.changes, cwd, onToast, task]);

  const discardChange = useCallback(
    async (path: string) => {
      if (!cwd || !task) return;
      if (!window.confirm(`将丢弃 ${path} 的全部改动，确认继续？`)) return;
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
    setCommitting(true);
    try {
      const input = await codingApi.commitInput(cwd, task.id);
      const message = window.prompt("提交信息", input.split("\n")[0]?.replace(/^任务名称：/, "") ?? "");
      if (!message?.trim()) return;
      const hash = await codingApi.commit(cwd, task.id, message.trim());
      await useTaskStore.getState().refreshTaskState();
      onToast?.(`已提交 ${hash.slice(0, 8)}`);
    } catch (error) {
      onToast?.(`提交失败：${String(error).replace(/^Error:\s*/, "")}`);
    } finally {
      setCommitting(false);
    }
  }, [cwd, onToast, task]);

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
      problemCount: problems.length,
      changedFileCount: taskChangeCount,
      canCommitChanges: changeSet?.baselineMode !== "filesystem",
      canRollbackChanges: (changeSet?.rollbackUnsafeFiles?.length ?? 0) === 0,
      setActivityView,
      setBottomView,
      openDocTab: (kind) => useTabStore.getState().openDoc(kind),
      runAllVerifications: () => void runVerifications(verificationCommands),
      rerunVerification: () => void runVerifications(verificationCommands),
      rollbackTask: () => void rollbackTask(),
      newTask: () => useTaskStore.setState({
        task: null,
        changeSet: null,
        verifications: [],
        problems: [],
        ledger: [],
        orchestrator: null,
      }),
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
      changeSet?.baselineMode,
      changeSet?.rollbackUnsafeFiles?.length,
      cwd,
      verificationCommands,
      indexReady,
      generateComments,
      openFindReferences,
      openGoToDefinition,
      openImpactAnalysis,
      problems.length,
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
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.repeat) return;
      if (isGlobalShortcutBlocked()) return;
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
  }, [cwd, toggleBottom]);

  const style = useMemo(
    () =>
      ({
        "--coding-explorer-width": `${effectiveLayout.explorerWidth}px`,
        "--coding-agent-width": `${effectiveLayout.agentWidth}px`,
        "--coding-bottom-height": `${effectiveLayout.bottomHeight}px`,
      }) as CSSProperties,
    [effectiveLayout],
  );

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
          <span className="coding-workbench__repo" title={cwd}>
            <FolderOpen size={13} />
            <span>{basename(cwd)}</span>
          </span>
          <TaskSwitcher
            tasks={summaries}
            activeId={task?.id}
            onSelect={(taskId) => void activateCodingTask(taskId)}
            onNew={() => useTaskStore.setState({
              task: null,
              changeSet: null,
              verifications: [],
              problems: [],
              ledger: [],
              orchestrator: null,
            })}
            onRename={renameCodingTask}
            onDelete={deleteCodingTask}
          />
        </div>
        <button
          type="button"
          className="coding-workbench__palette-btn"
          onClick={() => setPaletteMode("commands")}
          aria-label="打开命令面板"
          title="命令面板 ⌘⇧P"
        >
          <Search size={13} />
          <span>搜索命令与文件</span>
          <kbd>⌘⇧P</kbd>
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
          active={activityView}
          onChange={setActivityView}
          contextCount={contextPaths.length}
        />
      </div>

      <aside className="coding-workbench__explorer" aria-label="资源管理器">
        <div className="coding-explorer__heading">
          <span>{EXPLORER_TITLES[activityView]}</span>
          {activityView === "files" && (
            <span className="coding-explorer__heading-actions">
              <button type="button" onClick={() => void createWorkspaceEntry(false)} title="新建文件" aria-label="新建文件">
                <FilePlus2 size={13} />
              </button>
              <button type="button" onClick={() => void createWorkspaceEntry(true)} title="新建目录" aria-label="新建目录">
                <FolderPlus size={13} />
              </button>
            </span>
          )}
        </div>
        {activityView === "files" && (
          <FileTreeView
            rootPath={cwd}
            selectedPath={activeTabId ?? undefined}
            selectedDirectoryPath={selectedDirectory}
            onFileSelect={(path) => void openFile(path)}
            onDirectorySelect={setSelectedDirectory}
            onToast={onToast}
            refreshKey={treeRefresh.revision}
            refreshPaths={treeRefresh.paths}
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
            activePath={activeRelativePath}
            onAdd={(path) => setContextPaths((current) => [...new Set([...current, path])])}
            onRemove={(path) =>
              setContextPaths((current) => current.filter((entry) => entry !== path))
            }
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
          onViewChange={handleFileViewChange}
          viewBusy={Boolean(
            activeFileTab
            && diffLoadingPath === workspaceRelativePath(cwd, activeFileTab.relativePath),
          )}
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
            onCancel={() => onCancelRun?.()}
            onContinue={continueInterruptedTask}
            onOpenChanges={() => setActivityView("changes")}
            onOpenReport={() => useTabStore.getState().openDoc("delivery")}
            onToast={onToast}
          />
        ) : (
          <TaskStarter
            models={models}
            modelId={modelId}
            onModelChange={(next) => void changeTaskModel(next)}
            starting={starting}
            error={startError}
            apiReady={apiReady}
            contextPaths={contextPaths}
            onStart={(requirement) => void startTask(requirement)}
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
          problems={problems}
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
          onToast={onToast}
        />
      )}

      <footer className="coding-workbench__status" role="status" aria-label="工作台状态">
        {task ? (
          <span>
            {statusSummary({
              phase: task.phase,
              changedFileCount: taskChangeCount,
              problemCount: problems.length,
              repairRound: orchestrator?.repairRounds.length,
              maxRepairRounds: orchestrator?.maxRepairRounds,
            })}
          </span>
        ) : (
          <span>就绪</span>
        )}
        {problems.length > 0 && (
          <button type="button" onClick={() => setBottomView("problems")}>
            {problems.length} 个问题
          </button>
        )}
        <span className="coding-workbench__status-spacer" />
        {indexing && <span>正在建立文件索引…</span>}
        <span>
          {changeSet
            ? changeSet.baselineMode === "filesystem" ? "本地检查点" : "Git 基线"
            : "Agent 就绪"}
        </span>
      </footer>

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
