import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { ArrowLeft, Code2, FolderGit2, Search, Settings2 } from "lucide-react";

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
  onPhaseChanged,
  onVerificationOutput,
  onVerificationUpdated,
} from "./lib/tauri-api";
import type { DetectedCommand, Problem } from "./lib/types";
import { DeliveryReportTab } from "./main/docs/DeliveryReportTab";
import { ProjectProfileTab } from "./main/docs/ProjectProfileTab";
import { TaskDagTab } from "./main/docs/TaskDagTab";
import { BottomPanel } from "./panels/BottomPanel";
import { TabContainer } from "./main/TabContainer";
import { ActivityBar } from "./shell/ActivityBar";
import { CommandPalette, type PaletteMode, type PaletteSymbol } from "./shell/CommandPalette";
import { TaskSwitcher } from "./shell/TaskSwitcher";
import { isFileTab, useTabStore } from "./store/tab-store";
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
  ) => Promise<string | undefined>;
  onSendMessage?: (text: string) => void;
  onCancelRun?: () => void;
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
 * Shell of the coding workbench: top bar, activity bar, explorer, main tab area,
 * Agent pane, bottom panel and status bar. This task establishes the layout and
 * pane sizing only; each region's content is filled in by later tasks.
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
  sessionId = null,
  onStartRun,
  onSendMessage,
  onCancelRun,
}: CodingWorkbenchProps) {
  // Live transcript for the task's session, read straight from the shared store.
  const transcript = useSessionStore((state) =>
    sessionId ? state.transcripts[sessionId] : undefined,
  );
  const messages = transcript?.messages ?? [];
  const streaming = useSessionStore((state) => state.streaming);
  const awaitingPermission = usePermissionStore(
    (state) => (sessionId ? (state.queues[sessionId]?.length ?? 0) > 0 : false),
  );
  const awaitingQuestion = useQuestionStore(
    (state) => (sessionId ? (state.queues[sessionId]?.length ?? 0) > 0 : false),
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
  const [reveal, setReveal] = useState<{ line: number; column: number; key: number }>();
  const [contextPaths, setContextPaths] = useState<string[]>([]);
  const [replacing, setReplacing] = useState(false);
  const [modelId, setModelId] = useState(defaultModelId);
  const [startError, setStartError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [sending, setSending] = useState(false);
  const [phaseReason, setPhaseReason] = useState<string>();
  const [blocker, setBlocker] = useState<string | null>(null);
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [committing, setCommitting] = useState(false);
  const [detected, setDetected] = useState<DetectedCommand[]>([]);
  const [runningVerification, setRunningVerification] = useState(false);
  const [commandOutput, setCommandOutput] = useState("");
  const [terminalActivated, setTerminalActivated] = useState(false);
  /** Bumped whenever the task's evidence changes, so an open report reloads. */
  const [reportRevision, setReportRevision] = useState(0);

  const task = useTaskStore((state) => state.task);
  const summaries = useTaskStore((state) => state.summaries);
  const changeSet = useTaskStore((state) => state.changeSet);
  const problems = useTaskStore((state) => state.problems);
  const verifications = useTaskStore((state) => state.verifications);
  const orchestrator = useTaskStore((state) => state.orchestrator);

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
      if (disposed) return;
      useTaskStore.getState().applyPhase(event.taskId, event.phase);
      setPhaseReason(event.reason);
      setBlocker(event.blocker ?? null);
      setReportRevision((value) => value + 1);
      void useTaskStore.getState().refreshTaskState();
    }).then((unlisten) => {
      if (disposed) unlisten();
      else unlisteners.push(unlisten);
    });
    void onVerificationUpdated((record) => {
      if (disposed) return;
      useTaskStore.getState().applyVerification(record);
    }).then((unlisten) => {
      if (disposed) unlisten();
      else unlisteners.push(unlisten);
    });
    void onVerificationOutput((event) => {
      if (disposed) return;
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

  // Detect the project's real verification commands once per workspace.
  useEffect(() => {
    if (!cwd) {
      setDetected([]);
      return;
    }
    let cancelled = false;
    void codingApi
      .detectCommands(cwd)
      .then((commands) => {
        if (!cancelled) setDetected(commands);
      })
      .catch(() => {
        if (!cancelled) setDetected([]);
      });
    return () => {
      cancelled = true;
    };
  }, [cwd]);

  const activeFileTab = useMemo(() => {
    const found = tabs.find((tab) => tab.id === activeTabId);
    return found && isFileTab(found) ? found : null;
  }, [activeTabId, tabs]);

  const symbols = activeFileTab ? (symbolsByPath[activeFileTab.id] ?? []) : [];
  const activeFileName = activeFileTab?.name;
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

  /**
   * Save a tab. The backend compares the hash we loaded against what is on disk
   * and refuses the write when they differ, which is how a concurrent Agent edit
   * is caught instead of silently overwritten.
   */
  const saveFile = useCallback(
    async (id: string) => {
      const tab = useTabStore.getState().tabs.find((entry) => entry.id === id);
      if (!tab || !isFileTab(tab)) return;
      try {
        const saved = await codingWriteDocument(cwd, id, tab.draft, tab.hash);
        useTabStore.getState().markSaved(id, saved.content, saved.hash);
        onToast?.(`已保存 ${tab.name}`);
      } catch (error) {
        const message = String(error).replace(/^Error:\s*/, "");
        if (message.includes("保存冲突")) {
          useTabStore.getState().markConflict(id);
          onToast?.(message);
          return;
        }
        onToast?.(`保存失败：${message}`);
      }
    },
    [cwd, onToast],
  );

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
      const plans: Array<{ path: string; count: number; content: string; hash: string }> = [];
      for (const relative of uniquePaths) {
        try {
          const document = await codingReadDocument(cwd, workspaceFilePath(cwd, relative));
          const count = countOccurrences(document.content, query);
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

      setReplacing(true);
      let changed = 0;
      let skipped = 0;
      try {
        for (const plan of plans) {
          const next = replaceAll(plan.content, query, replacement);
          try {
            await codingWriteDocument(
              cwd,
              workspaceFilePath(cwd, plan.path),
              next.content,
              plan.hash,
            );
            changed += 1;
          } catch {
            // A hash mismatch means someone else wrote the file first.
            skipped += 1;
          }
        }
      } finally {
        setReplacing(false);
      }
      onToast?.(
        skipped > 0
          ? `已替换 ${changed} 个文件，${skipped} 个因期间被其他程序修改而跳过`
          : `已替换 ${changed} 个文件`,
      );
    },
    [cwd, onToast],
  );

  // Close every tab when the workspace changes; their paths no longer apply.
  useEffect(() => {
    useTabStore.getState().closeAll();
    setSymbolsByPath({});
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

  const notImplemented = useCallback(
    (what: string) => onToast?.(`${what}将在后续版本接入`),
    [onToast],
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
    async (requirement: string, planRequired: boolean) => {
      if (!cwd || !onStartRun) return;
      setStarting(true);
      setStartError(null);
      try {
        const created = await useTaskStore.getState().createTask(deriveName(requirement), requirement);
        if (!created) {
          setStartError(useTaskStore.getState().error ?? "创建任务失败");
          return;
        }
        // Record the baseline so pre-existing user edits stay protected.
        const dirty = changeSet?.changes.map((change) => change.path) ?? [];
        await codingApi.captureBaseline(cwd, created.id, dirty).catch(() => undefined);
        await codingApi.submitRequirement(cwd, created.id, planRequired);
        const session = await onStartRun(cwd, requirement, planRequired, modelId);
        if (!session) {
          setStartError("未能启动 Agent 会话");
          return;
        }
        await useTaskStore.getState().selectTask(created.id);
      } catch (error) {
        setStartError(String(error).replace(/^Error:\s*/, ""));
      } finally {
        setStarting(false);
      }
    },
    [changeSet?.changes, cwd, deriveName, modelId, onStartRun],
  );

  const sendFollowup = useCallback(
    (text: string) => {
      if (!onSendMessage) return;
      setSending(true);
      try {
        onSendMessage(text);
      } finally {
        setSending(false);
      }
    },
    [onSendMessage],
  );

  const approvePlan = useCallback(async () => {
    if (!cwd || !task) return;
    try {
      await codingApi.approvePlan(cwd, task.id);
      await useTaskStore.getState().refreshTaskState();
    } catch (error) {
      onToast?.(`批准计划失败：${String(error).replace(/^Error:\s*/, "")}`);
    }
  }, [cwd, onToast, task]);

  const rollbackTask = useCallback(async () => {
    if (!cwd || !task) return;
    const count = changeSet?.changes.filter((change) => !change.preExisting).length ?? 0;
    if (
      !window.confirm(
        `将撤销本任务产生的 ${count} 个文件改动，任务开始前你自己的改动不受影响。确认回滚？`,
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
      setBusyPath(path);
      try {
        await codingApi.discardFile(cwd, task.id, path);
        await useTaskStore.getState().refreshTaskState();
      } catch (error) {
        onToast?.(`丢弃失败：${String(error).replace(/^Error:\s*/, "")}`);
      } finally {
        setBusyPath(null);
      }
    },
    [cwd, onToast, task],
  );

  /**
   * Run verifications, then let the orchestrator decide what the results mean.
   * The workbench never derives a phase from the records itself.
   */
  const runVerifications = useCallback(
    async (commands: DetectedCommand[]) => {
      if (!cwd || !task || commands.length === 0) return;
      setRunningVerification(true);
      setCommandOutput("");
      setBottomView("output");
      try {
        for (const command of commands) {
          try {
            const record = await codingApi.runVerification(
              cwd,
              task.id,
              command.kind,
              command.command,
            );
            // Stop the batch at the first genuine failure; a later command would
            // only add noise to the diagnosis.
            if (record.status !== "passed") break;
          } catch (error) {
            onToast?.(`执行 ${command.command} 失败：${String(error).replace(/^Error:\s*/, "")}`);
            break;
          }
        }
        await codingApi.reportVerification(cwd, task.id);
        await useTaskStore.getState().refreshTaskState();
      } finally {
        setRunningVerification(false);
      }
    },
    [cwd, onToast, setBottomView, task],
  );

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

  /**
   * Commands available right now. Later tasks replace the placeholder handlers
   * with real task, verification and delivery actions.
   */
  const taskChangeCount =
    changeSet?.changes.filter((change) => !change.preExisting).length ?? 0;

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
      approvePlan: () => void approvePlan(),
      rollbackTask: () => void rollbackTask(),
      newTask: () => useTaskStore.setState({ task: null }),
      commitChanges: () => void commitChanges(),
      explain: () => notImplemented("代码解释"),
      generateComments: () => notImplemented("注释生成"),
      toggleBottom: () => toggleBottom(),
    }),
    [
      approvePlan,
      commitChanges,
      cwd,
      detected,
      notImplemented,
      problems.length,
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
    // Capture phase so the workbench claims these before app-level handlers.
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
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
          <button type="button" className="coding-icon-btn" onClick={onExit} aria-label="返回">
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
        <button type="button" className="coding-icon-btn" onClick={onExit} aria-label="返回">
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
          onSelect={(taskId) => void useTaskStore.getState().selectTask(taskId)}
          onNew={() => useTaskStore.setState({ task: null })}
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
        <div className="coding-explorer__heading">{EXPLORER_TITLES[activityView]}</div>
        {activityView === "files" && (
          <FileTreeView
            rootPath={cwd}
            selectedPath={activeTabId ?? undefined}
            selectedDirectoryPath={selectedDirectory}
            onFileSelect={(path) => void openFile(path)}
            onDirectorySelect={setSelectedDirectory}
            onToast={onToast}
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
            onOpenDiff={(change) => {
              void openFile(workspaceFilePath(cwd, change.path));
              useTabStore.getState().setView(workspaceFilePath(cwd, change.path), "diff");
              if (task) void codingApi.markReviewed(cwd, task.id, change.path).catch(() => undefined);
            }}
            onDiscard={(change) => void discardChange(change.path)}
            onCommit={() => void commitChanges()}
            onRollback={() => void rollbackTask()}
          />
        )}
        {activityView === "symbols" && (
          <SymbolView
            symbols={symbols}
            activeFileName={activeFileName}
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
          onClose={(id) => useTabStore.getState().closeTab(id)}
          onDraftChange={(id, draft) => useTabStore.getState().updateDraft(id, draft)}
          onSave={(id) => void saveFile(id)}
          onViewChange={(id, view) => useTabStore.getState().setView(id, view)}
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
            sessionId={sessionId}
            messages={messages}
            streaming={streaming}
            phaseReason={phaseReason}
            blocker={blocker}
            awaitingPermission={awaitingPermission}
            awaitingQuestion={awaitingQuestion}
            models={models}
            modelId={modelId}
            sending={sending}
            onModelChange={setModelId}
            onSend={sendFollowup}
            onCancel={() => onCancelRun?.()}
            onApprovePlan={() => void approvePlan()}
            onOpenReport={() => useTabStore.getState().openDoc("delivery")}
            onToast={onToast}
          />
        ) : (
          <TaskStarter
            models={models}
            modelId={modelId}
            onModelChange={setModelId}
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
          symbols={symbols}
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
