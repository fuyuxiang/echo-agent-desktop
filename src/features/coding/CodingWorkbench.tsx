import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { ArrowLeft, Code2, FilePlus2, FolderGit2, FolderPlus, Search, Settings2 } from "lucide-react";

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
import { buildFileIndex } from "./lib/file-index";
import { countOccurrences, describeReplacePlan, replaceAll } from "./lib/replace";
import { isBusyPhase, statusSummary } from "./lib/phase";
import {
  codingApi,
  onIndexRemoved,
  onIndexUpdated,
  onPhaseChanged,
  onVerificationOutput,
  onVerificationUpdated,
} from "./lib/tauri-api";
import { getSymbolIndexClient } from "./lib/symbol-index";
import type { DetectedCommand, IndexStatus, Problem } from "./lib/types";
import { useTaskLifecycle } from "./lib/task-lifecycle";
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
import { useWorkbenchStore } from "./store/workbench-store";

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
    planRequired: boolean,
    modelId?: string,
    contextPaths?: string[],
    onSessionReady?: (sessionId: string) => Promise<void>,
  ) => Promise<string | undefined>;
  /** Focus a task's persisted Agent session without leaving the workbench. */
  onActivateSession?: (sessionId: string, cwd: string) => Promise<void>;
  onChangeModel?: (modelId: string) => void | Promise<void>;
  onSendMessage?: (text: string) => boolean | void | Promise<boolean | void>;
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
 * Pointer-drag handler shared by both vertical separators. `fromRight` measures
 * from the window's right edge, which is what the Agent pane needs.
 */
function useDragWidth(apply: (value: number) => void, fromRight: boolean) {
  return useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const move = (moveEvent: PointerEvent) => {
        apply(fromRight ? window.innerWidth - moveEvent.clientX : moveEvent.clientX);
      };
      const stop = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", stop);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", stop);
    },
    [apply, fromRight],
  );
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
  useTaskLifecycle(cwd);
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
  const [committing, setCommitting] = useState(false);
  const [detected, setDetected] = useState<DetectedCommand[]>([]);
  const [detectedReady, setDetectedReady] = useState(false);
  const [runningVerification, setRunningVerification] = useState(false);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [commandOutput, setCommandOutput] = useState("");
  const [terminalActivated, setTerminalActivated] = useState(false);
  const [treeRevision, setTreeRevision] = useState(0);
  /** Bumped whenever the task's evidence changes, so an open report reloads. */
  const [reportRevision, setReportRevision] = useState(0);
  const activeRunIdRef = useRef<string | null>(null);
  const autoVerificationRef = useRef<string | null>(null);
  const repairPromptRef = useRef<string | null>(null);

  const task = useTaskStore((state) => state.task);
  const summaries = useTaskStore((state) => state.summaries);
  const changeSet = useTaskStore((state) => state.changeSet);
  const problems = useTaskStore((state) => state.problems);
  const verifications = useTaskStore((state) => state.verifications);
  const orchestrator = useTaskStore((state) => state.orchestrator);

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

  // Keep clean editor tabs live when the Agent or another process writes an
  // indexed source file. Unsaved drafts are never overwritten; they become an
  // explicit conflict that the user can compare or reload.
  useEffect(() => {
    if (!cwd) return;
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    const matchingTab = (relativePath: string) => useTabStore.getState().tabs.find(
      (entry) => isFileTab(entry) && entry.relativePath.replace(/\\/g, "/") === relativePath,
    );
    void onIndexUpdated((event) => {
      if (disposed || event.root !== cwd || !matchingTab(event.file)) return;
      void (async () => {
        const before = matchingTab(event.file);
        if (!before || !isFileTab(before)) return;
        if (before.draft !== before.original) {
          useTabStore.getState().markConflict(before.id);
          return;
        }
        try {
          const document = await codingReadDocument(cwd, before.id);
          if (disposed) return;
          const current = matchingTab(event.file);
          if (!current || !isFileTab(current)) return;
          if (current.draft !== current.original) {
            useTabStore.getState().markConflict(current.id);
          } else {
            useTabStore.getState().markSaved(current.id, document.content, document.hash);
          }
        } catch {
          const current = matchingTab(event.file);
          if (current && isFileTab(current)) {
            useTabStore.getState().setError(current.id, "文件已被删除或暂时无法读取");
          }
        }
      })();
    }).then((unlisten) => {
      if (disposed) unlisten();
      else unlisteners.push(unlisten);
    });
    void onIndexRemoved((event) => {
      if (disposed || event.root !== cwd) return;
      const current = matchingTab(event.file);
      if (!current || !isFileTab(current)) return;
      if (current.draft !== current.original) {
        useTabStore.getState().markConflict(current.id);
      } else {
        useTabStore.getState().setError(current.id, "文件已被 Agent 或其他程序删除");
      }
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
    if (["implementing", "repairing"].includes(activeTask.phase)) {
      return { taskId: activeTask.id, closeRound: false };
    }
    if (["gating", "blocked", "delivered"].includes(activeTask.phase)) {
      try {
        await codingApi.beginFollowup(cwd, activeTask.id);
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
    await codingApi.syncFromGit(cwd, context.taskId);
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

  const openTaskDiff = useCallback(async (path: string) => {
    if (!cwd || !task) return;
    const absolutePath = workspaceFilePath(cwd, path);
    setBusyPath(path);
    try {
      const diff = await codingApi.changeDiff(cwd, task.id, path);
      await openFile(absolutePath);
      useTabStore.getState().setDiff(absolutePath, diff.original, diff.modified, diff.binary);
      await codingApi.markReviewed(cwd, task.id, path);
      await useTaskStore.getState().refreshTaskState();
      if (diff.binary) onToast?.("二进制文件无法显示文本差异，已显示文件状态摘要");
    } catch (error) {
      onToast?.(`打开任务差异失败：${String(error).replace(/^Error:\s*/, "")}`);
    } finally {
      setBusyPath(null);
    }
  }, [cwd, onToast, openFile, task]);

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
        if (!signal.aborted) setFilePaths(paths);
      },
    })
      .then((result) => {
        if (!signal.aborted) setFilePaths(result.paths);
      })
      .finally(() => {
        if (!signal.aborted) setIndexing(false);
      });
    return () => {
      signal.aborted = true;
    };
  }, [cwd]);

  const startExplorerDrag = useDragWidth(setExplorerWidth, false);
  const startAgentDrag = useDragWidth(setAgentWidth, true);

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
      setTreeRevision((value) => value + 1);
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
    async (requirement: string, planRequired: boolean) => {
      if (!cwd || !onStartRun) return;
      setStarting(true);
      setStartError(null);
      let createdId: string | undefined;
      try {
        const created = await useTaskStore.getState().createTask(deriveName(requirement), requirement);
        if (!created) {
          setStartError(useTaskStore.getState().error ?? "创建任务失败");
          return;
        }
        createdId = created.id;
        // The exact task-start worktree (including existing dirty content) is
        // persisted before the Agent gets permission to touch the repository.
        await codingApi.captureBaseline(cwd, created.id, []);
        await codingApi.submitRequirement(cwd, created.id, planRequired);
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
          requirement,
          planRequired,
          modelId,
          contextPaths,
          bindSession,
        );
        if (!session) {
          const reason = "未能启动 Agent 会话，任务已停止且不会继续执行";
          await codingApi.reportStartFailed(cwd, created.id, reason).catch(() => undefined);
          setStartError(reason);
          await useTaskStore.getState().refreshTaskState();
          return;
        }
        // Compatibility fallback for embedders that have not implemented the
        // pre-send callback yet. The desktop host binds through `bindSession`
        // before it starts the Agent turn, closing the fast-response race.
        if (!boundSession) await bindSession(session);
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
    async (text: string, mutating = true) => {
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
          if (["gating", "blocked", "delivered"].includes(task.phase)) {
            if (!cwd) return false;
            await codingApi.beginFollowup(cwd, task.id);
            await useTaskStore.getState().refreshTaskState();
            reopened = true;
          } else if (!["implementing", "repairing"].includes(task.phase)) {
            onToast?.(task.phase === "verifying"
              ? "正在验证当前改动，请等待验证结束后再补充开发要求"
              : "当前任务阶段不能修改代码");
            return false;
          }
        }
        const accepted = await onSendMessage(text);
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
      task,
    ],
  );

  const resolvePlan = useCallback(async (
    outcome: "approved" | "cancelled" | "abandoned",
    entries: string[],
  ) => {
    if (!cwd || !task) return;
    try {
      await codingApi.resolvePlan(cwd, task.id, outcome, entries);
      await useTaskStore.getState().refreshTaskState();
    } catch (error) {
      onToast?.(`同步计划状态失败：${String(error).replace(/^Error:\s*/, "")}`);
      throw error;
    }
  }, [cwd, onToast, task]);

  const handlePlanSyncFailure = useCallback(async (reason: string) => {
    if (!cwd || !task) return;
    // Runtime approval has already released the Agent. Stop it before marking
    // the workflow blocked, then capture any writes that landed in that narrow
    // window so review and rollback remain truthful.
    await Promise.resolve(onCancelRun?.()).catch(() => undefined);
    await codingApi.syncFromGit(cwd, task.id).catch(() => undefined);
    await codingApi.reportStartFailed(
      cwd,
      task.id,
      `计划审批已生效，但任务状态保存失败：${reason}`,
    ).catch(() => undefined);
    await useTaskStore.getState().refreshTaskState().catch(() => undefined);
    onToast?.("已停止 Agent，避免在未受管的任务状态下继续修改代码");
  }, [cwd, onCancelRun, onToast, task]);

  const finalizeDelivery = useCallback(async () => {
    if (!cwd || !task) return;
    try {
      await codingApi.finalizeDelivery(cwd, task.id);
      await useTaskStore.getState().refreshTaskState();
      setReportRevision((value) => value + 1);
      useTabStore.getState().openDoc("delivery");
      onToast?.("任务已通过验收，可以提交或生成交付材料");
    } catch (error) {
      onToast?.(`暂时无法交付：${String(error).replace(/^Error:\s*/, "")}`);
    }
  }, [cwd, onToast, task]);

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

  /**
   * Run verifications, then let the orchestrator decide what the results mean.
   * The workbench never derives a phase from the records itself.
   */
  const runVerifications = useCallback(
    async (commands: DetectedCommand[]) => {
      if (!cwd || !task || runningVerification) return;
      const taskId = task.id;
      if (task.phase !== "verifying") {
        if (!["gating", "blocked", "delivered"].includes(task.phase)) {
          onToast?.("当前任务正在执行，暂不能启动新的验证批次");
          return;
        }
        try {
          await codingApi.beginVerification(cwd, taskId);
          await useTaskStore.getState().refreshTaskState();
        } catch (error) {
          onToast?.(`无法启动验证：${String(error).replace(/^Error:\s*/, "")}`);
          return;
        }
      }
      setRunningVerification(true);
      setCommandOutput("");
      setBottomView("output");
      let mayReport = commands.length === 0;
      try {
        for (const command of commands) {
          const runId = crypto.randomUUID();
          activeRunIdRef.current = runId;
          setActiveRunId(runId);
          try {
            const record = await codingApi.runVerification(
              cwd,
              taskId,
              command.kind,
              command.command,
              undefined,
              runId,
            );
            mayReport = record.status !== "cancelled";
            // Stop the batch at the first genuine failure; a later command would
            // only add noise to the diagnosis.
            if (record.status !== "passed") break;
          } catch (error) {
            onToast?.(`执行 ${command.command} 失败：${String(error).replace(/^Error:\s*/, "")}`);
            mayReport = false;
            break;
          }
        }
        if (mayReport) {
          await codingApi.reportVerification(cwd, taskId);
          await useTaskStore.getState().refreshTaskState();
        }
      } catch (error) {
        onToast?.(`无法更新验证结果：${String(error).replace(/^Error:\s*/, "")}`);
        await useTaskStore.getState().refreshTaskState().catch(() => undefined);
      } finally {
        activeRunIdRef.current = null;
        setActiveRunId(null);
        setRunningVerification(false);
      }
    },
    [cwd, onToast, runningVerification, setBottomView, task],
  );

  // Verification is part of the orchestrated pipeline, not a hidden manual
  // step. Once command detection is complete, every verification phase runs.
  useEffect(() => {
    if (task?.phase !== "verifying") {
      autoVerificationRef.current = null;
      return;
    }
    if (!detectedReady || runningVerification) return;
    const key = `${cwd}:${task.id}:${task.updatedAt}`;
    if (autoVerificationRef.current === key) return;
    autoVerificationRef.current = key;
    void runVerifications(detected);
  }, [cwd, detected, detectedReady, runVerifications, runningVerification, task]);

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
    const key = `${task.id}:${round}`;
    if (repairPromptRef.current === key) return;
    repairPromptRef.current = key;
    const details = problems.length > 0
      ? problems.map((problem, index) =>
          `${index + 1}. [${problem.kind}] ${problem.file ?? "未知文件"}${problem.line ? `:${problem.line}` : ""} — ${problem.message}`,
        ).join("\n")
      : "验证未通过，但未能提取结构化诊断。请查看验证输出并定位根因。";
    sendFollowup(
      `上一轮验证未通过，请修复下列问题。必须检查真实命令输出、完成代码修改并保持现有功能兼容；修复完成后简要说明。\n\n${details}`,
    );
  }, [
    hostSessionId,
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

  const requestExplanation = useCallback((scope: "function" | "class" | "module" | "system") => {
    if (!onSendMessage || !activeSessionId) {
      onToast?.("请先启动或恢复一个开发任务");
      return;
    }
    const target = scope === "system"
      ? "当前代码库的整体架构"
      : `${activeRelativePath ?? "当前文件"}中的当前${scope === "function" ? "函数" : scope === "class" ? "类" : "模块"}`;
    void sendFollowup(`请解释${target}：说明职责、关键数据流、依赖关系、边界条件和潜在风险。只做分析，不修改文件。`, false);
  }, [activeRelativePath, activeSessionId, onSendMessage, onToast, sendFollowup]);

  const generateComments = useCallback(() => {
    if (!activeRelativePath) {
      onToast?.("请先打开需要补充注释的文件");
      return;
    }
    sendFollowup(
      `请为 ${activeRelativePath} 补充必要且简洁的代码注释与公开 API 文档。不要复述显而易见的实现；保持项目既有风格，并直接修改文件。`,
    );
  }, [activeRelativePath, onToast, sendFollowup]);

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
      hasTask: Boolean(task),
      busy: streaming || isBusyPhase(task?.phase),
      taskPhase: task?.phase,
      problemCount: problems.length,
      changedFileCount: taskChangeCount,
      setActivityView,
      setBottomView,
      openDocTab: (kind) => useTabStore.getState().openDoc(kind),
      runAllVerifications: () => void runVerifications(detected),
      rerunVerification: () => void runVerifications(detected),
      approvePlan: () => onToast?.("请在右侧计划面板中审阅并批准计划"),
      rollbackTask: () => void rollbackTask(),
      newTask: () => useTaskStore.setState({
        task: null,
        changeSet: null,
        verifications: [],
        problems: [],
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
      cwd,
      detected,
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
    const client = getSymbolIndexClient(cwd);
    void codingApi.indexBootstrap(cwd).then((status) => {
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
        "--coding-explorer-width": `${explorerWidth}px`,
        "--coding-agent-width": `${agentWidth}px`,
        "--coding-bottom-height": `${bottomHeight}px`,
      }) as CSSProperties,
    [agentWidth, bottomHeight, explorerWidth],
  );

  if (!cwd) {
    return (
      <div className="coding-workbench coding-workbench--empty">
        <header className="coding-workbench__topbar" data-tauri-drag-region>
          <button type="button" className="coding-icon-btn" onClick={exitSafely} aria-label="返回">
            <ArrowLeft size={16} />
          </button>
          <Code2 size={16} />
          <strong>Echo Code</strong>
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
    <div className={`coding-workbench${bottomOpen ? " is-bottom-open" : ""}`} style={style}>
      <header className="coding-workbench__topbar" data-tauri-drag-region>
        <button type="button" className="coding-icon-btn" onClick={exitSafely} aria-label="返回">
          <ArrowLeft size={16} />
        </button>
        <Code2 size={16} />
        <strong>Echo Code</strong>
        <span className="coding-workbench__repo" title={cwd}>
          {basename(cwd)}
        </span>
        <TaskSwitcher
          tasks={summaries}
          activeId={task?.id}
          onSelect={(taskId) => void (async () => {
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
          })()}
          onNew={() => useTaskStore.setState({
            task: null,
            changeSet: null,
            verifications: [],
            problems: [],
            orchestrator: null,
          })}
        />
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
        <button
          type="button"
          className="coding-icon-btn"
          onClick={onOpenSettings}
          aria-label="设置"
        >
          <Settings2 size={15} />
        </button>
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
            refreshKey={treeRevision}
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
            busyPath={busyPath}
            committing={committing}
            canCommit={task?.phase === "delivered" && !changeSet?.committedHash}
            canRollback={
              !changeSet?.committedHash
              && !runningVerification
              && !streaming
              && Boolean(task && ["gating", "delivered", "blocked"].includes(task.phase))
            }
            canDiscard={
              !runningVerification
              && !streaming
              && !sending
              && Boolean(task && [
                "implementing",
                "repairing",
                "gating",
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
        className="coding-workbench__vsplit"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整资源管理器宽度"
        tabIndex={0}
        onPointerDown={startExplorerDrag}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft") setExplorerWidth(explorerWidth - 16);
          if (event.key === "ArrowRight") setExplorerWidth(explorerWidth + 16);
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
          onViewChange={(id, view) => useTabStore.getState().setView(id, view)}
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
          renderDoc={(kind) => {
            const openRelative = (path: string) => void openFile(workspaceFilePath(cwd, path));
            if (kind === "delivery") {
              return (
                <DeliveryReportTab
                  root={cwd}
                  taskId={task?.id ?? null}
                  revision={reportRevision}
                  onOpenFile={openRelative}
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
        className="coding-workbench__vsplit"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整 Agent 面板宽度"
        tabIndex={0}
        onPointerDown={startAgentDrag}
        onKeyDown={(event) => {
          // The Agent pane grows leftwards, so the arrows are mirrored.
          if (event.key === "ArrowLeft") setAgentWidth(agentWidth + 16);
          if (event.key === "ArrowRight") setAgentWidth(agentWidth - 16);
        }}
      />

      <aside className="coding-workbench__agent" aria-label="Agent 面板">
        {task ? (
          <AgentPane
            task={task}
            sessionId={activeSessionId}
            messages={messages}
            streaming={streaming}
            phaseReason={phaseReason ?? task.phaseReason ?? undefined}
            blocker={blocker !== undefined ? blocker : task.blocker}
            awaitingPermission={awaitingPermission}
            awaitingQuestion={awaitingQuestion}
            models={models}
            modelId={modelId}
            sending={sending}
            onModelChange={(next) => void changeTaskModel(next)}
            onSend={sendFollowup}
            onCancel={() => onCancelRun?.()}
            onPlanResolved={resolvePlan}
            onPlanSyncFailed={handlePlanSyncFailure}
            onFinalizeDelivery={finalizeDelivery}
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
            onStart={(requirement, planRequired) => void startTask(requirement, planRequired)}
            onOpenSettings={onOpenSettings}
            onToast={onToast}
          />
        )}
      </aside>

      {bottomOpen && (
        <BottomPanel
          root={cwd}
          view={bottomView}
          height={bottomHeight}
          onViewChange={setBottomView}
          onCollapse={() => toggleBottom(false)}
          onResize={setBottomHeight}
          problems={problems}
          records={verifications}
          detected={detected}
          running={runningVerification}
          hasTask={Boolean(task)}
          output={commandOutput}
          messages={messages}
          terminalActivated={terminalActivated}
          onActivateTerminal={() => setTerminalActivated(true)}
          onOpenProblem={openProblem}
          onRun={(command) => void runVerifications([command])}
          onRunAll={() => void runVerifications(detected)}
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
        {task && (
          <span>
            {statusSummary({
              phase: task.phase,
              changedFileCount: taskChangeCount,
              problemCount: problems.length,
              repairRound: orchestrator?.repairRounds.length,
              maxRepairRounds: orchestrator?.maxRepairRounds,
            })}
          </span>
        )}
        {problems.length > 0 && (
          <button type="button" onClick={() => setBottomView("problems")}>
            {problems.length} 个问题
          </button>
        )}
        <span className="coding-workbench__status-spacer" />
        {indexing && <span>正在建立文件索引…</span>}
        <span>{basename(cwd)}</span>
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
    </div>
  );
}
