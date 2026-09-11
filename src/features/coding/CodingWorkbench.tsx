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
import { filesystemPickDirectory } from "@/lib/agent-client";
import { isGlobalShortcutBlocked } from "@/lib/keyboard-scope";
import "@/styles/coding-workbench.css";

import { buildCommands, type CommandContext } from "./lib/commands";
import { buildFileIndex } from "./lib/file-index";
import { CommandPalette, type PaletteMode, type PaletteSymbol } from "./shell/CommandPalette";
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
}

function basename(path: string): string {
  const segments = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return segments[segments.length - 1] ?? path;
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
}: CodingWorkbenchProps) {
  const explorerWidth = useWorkbenchStore((state) => state.explorerWidth);
  const agentWidth = useWorkbenchStore((state) => state.agentWidth);
  const bottomHeight = useWorkbenchStore((state) => state.bottomHeight);
  const bottomOpen = useWorkbenchStore((state) => state.bottomOpen);
  const setExplorerWidth = useWorkbenchStore((state) => state.setExplorerWidth);
  const setAgentWidth = useWorkbenchStore((state) => state.setAgentWidth);
  const hydrateLayout = useWorkbenchStore((state) => state.hydrateLayout);

  const setActivityView = useWorkbenchStore((state) => state.setActivityView);
  const setBottomView = useWorkbenchStore((state) => state.setBottomView);
  const toggleBottom = useWorkbenchStore((state) => state.toggleBottom);

  const [selectedDirectory, setSelectedDirectory] = useState(cwd);
  const [paletteMode, setPaletteMode] = useState<PaletteMode | null>(null);
  const [filePaths, setFilePaths] = useState<string[]>([]);
  const [indexing, setIndexing] = useState(false);
  const [symbols] = useState<PaletteSymbol[]>([]);

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

  /**
   * Commands available right now. Later tasks replace the placeholder handlers
   * with real task, verification and delivery actions.
   */
  const commandContext = useMemo<CommandContext>(
    () => ({
      hasWorkspace: Boolean(cwd),
      hasTask: false,
      busy: false,
      problemCount: 0,
      changedFileCount: 0,
      setActivityView,
      setBottomView,
      openDocTab: () => notImplemented("报告与图表标签页"),
      runAllVerifications: () => notImplemented("验证执行"),
      rerunVerification: () => notImplemented("验证执行"),
      approvePlan: () => notImplemented("计划批准"),
      rollbackTask: () => notImplemented("任务回滚"),
      newTask: () => notImplemented("新建开发任务"),
      commitChanges: () => notImplemented("提交变更"),
      explain: () => notImplemented("代码解释"),
      generateComments: () => notImplemented("注释生成"),
      toggleBottom: () => toggleBottom(),
    }),
    [cwd, notImplemented, setActivityView, setBottomView, toggleBottom],
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

      <nav className="coding-workbench__activity" aria-label="活动栏" />

      <aside className="coding-workbench__explorer" aria-label="资源管理器">
        <FileTreeView
          rootPath={cwd}
          selectedDirectoryPath={selectedDirectory}
          onFileSelect={() => {}}
          onDirectorySelect={setSelectedDirectory}
          onToast={onToast}
        />
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

      <main className="coding-workbench__main" />

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

      <aside className="coding-workbench__agent" aria-label="Agent 面板" />

      <footer className="coding-workbench__status" role="status" aria-label="工作台状态">
        <span>{basename(cwd)}</span>
        {indexing && <span>正在建立文件索引…</span>}
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
          onOpenPath={(path) => notImplemented(`打开文件 ${path}`)}
          onOpenSymbol={(symbol) => notImplemented(`跳转符号 ${symbol.name}`)}
        />
      )}
    </div>
  );
}
