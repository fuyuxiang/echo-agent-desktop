/**
 * 文件树视图 —— 对齐 EchoAgent `context-viewer-components/DetailPanel/FileTree`。
 *
 * 左列：可展开/折叠的目录树（懒加载 `listDir`，展开时按需拉取子目录）。
 * 选中文件由父组件通过 onFileSelect 回调驱动主区域预览。
 *
 * 根目录取 cwd（会话工作区）。隐藏/构建目录已在后端过滤。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listDir, type DirEntry, type CodingGitFile } from "@/lib/agent-client";
import { formatFileSize } from "@/lib/file-utils";
import { ChevronRightIcon } from "@/foundation/components/Icon/icons";
import { InlineRenameField } from "./InlineRenameField";
import { FileTypeIcon } from "@/features/coding/lib/file-type-icon";
import { useFileTreeSelectionStore } from "@/features/coding/store/file-tree-selection-store";
import { FixedSizeList, type FixedSizeListHandle } from "@/features/coding/components/FixedSizeList";
import { useElementSize } from "@/lib/use-element-size";

/** 已加载的目录条目缓存：path → entries。 */
type LoadedMap = Map<string, DirEntry[]>;

function normalize(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

const GIT_STATUS_LETTER: Record<string, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  untracked: "U",
  ignored: "I",
  conflict: "!",
};

function letterForGitStatus(status: string): string {
  return GIT_STATUS_LETTER[status] ?? "?";
}

function gitStatusTooltip(file: CodingGitFile): string {
  const label: Record<string, string> = {
    added: "新增已暂存",
    modified: "已修改",
    deleted: "已删除",
    renamed: "已重命名",
    untracked: "未跟踪",
    ignored: "已忽略",
    conflict: "冲突",
  };
  const name = label[file.status] ?? file.status;
  if (file.added || file.removed) {
    return `${name}（+${file.added} / -${file.removed}）`;
  }
  return name;
}

/** Trim the workspace root from an absolute path; returns POSIX. */
function toWorkspaceRelative(root: string, absolute: string): string | null {
  if (!root) return null;
  const trimmed = absolute.replace(/\\/g, "/");
  const normRoot = root.replace(/\\/g, "/").replace(/\/+$/, "");
  if (trimmed === normRoot) return "";
  if (trimmed.startsWith(`${normRoot}/`)) {
    return trimmed.slice(normRoot.length + 1);
  }
  return null;
}

/**
 * Refresh the closest directory already represented in the tree. If an Agent
 * creates `src/new/module.ts` before `src/new` has ever been loaded, `src` (or
 * ultimately the root) is refreshed so the new intermediate directory still
 * appears.
 */
function closestLoadedParent(root: string, changedPath: string, loaded: LoadedMap): string {
  const normalizedRoot = normalize(root);
  let relative = normalize(changedPath);
  if (relative === normalizedRoot) return root;
  if (relative.startsWith(`${normalizedRoot}/`)) {
    relative = relative.slice(normalizedRoot.length + 1);
  }
  const parts = relative.replace(/^\.?\//, "").split("/").filter(Boolean);
  if (parts.length > 0) parts.pop();
  while (parts.length > 0) {
    const candidate = `${root.replace(/[\\/]+$/, "")}/${parts.join("/")}`;
    const loadedPath = [...loaded.keys()].find((path) => normalize(path) === normalize(candidate));
    if (loadedPath) return loadedPath;
    parts.pop();
  }
  return root;
}

interface FileTreeViewProps {
  /** 工作区根目录（绝对路径）。 */
  rootPath?: string;
  /** 当前选中的文件路径（高亮）。 */
  selectedPath?: string;
  /** 代码工作台中用作新建位置的目录。 */
  selectedDirectoryPath?: string;
  /** 选中文件回调。 */
  onFileSelect: (path: string) => void;
  /** 可选的目录选中回调；不传时保持原有文件树行为。 */
  onDirectorySelect?: (path: string) => void;
  /** 错误/提示回调。 */
  onToast?: (msg: string) => void;
  /** Increment to invalidate the lazy directory cache after creating entries. */
  refreshKey?: number;
  /** Changed workspace paths associated with refreshKey, for targeted reloads. */
  refreshPaths?: string[];
  /** Paths that are cut and awaiting paste; rendered with reduced opacity. */
  cutPaths?: Set<string>;
  /** Right-click on a tree node. The parent typically opens a context menu. */
  onContextMenu?: (event: React.MouseEvent, entry: DirEntry) => void;
  /** Path currently being inline-renamed; if set the matching node shows the input. */
  renamingPath?: string | null;
  /** Submit a new name for `renamingPath`. Resolves on success; rejects keep editing. */
  onRenameSubmit?: (path: string, newName: string) => Promise<void>;
  /** Cancel the inline rename (e.g. Escape, blur). */
  onRenameCancel?: () => void;
  /** SP2: include hidden dotfile entries (still honouring .gitignore / .echoagentignore). */
  includeHidden?: boolean;
  /** SP2: git status indexed by workspace-relative POSIX path. */
  gitStatusByPath?: Map<string, CodingGitFile>;
  /** SP2: top-level entries above this count trigger virtualisation. */
  topLevelThreshold?: number;
  /** SP2: row height used by the virtual list, in px. */
  virtualItemHeight?: number;
}

export function FileTreeView({
  rootPath,
  selectedPath,
  selectedDirectoryPath,
  onFileSelect,
  onDirectorySelect,
  onToast,
  refreshKey = 0,
  refreshPaths = [],
  cutPaths,
  onContextMenu,
  renamingPath,
  onRenameSubmit,
  onRenameCancel,
  includeHidden = false,
  gitStatusByPath,
  topLevelThreshold = 200,
  virtualItemHeight = 26,
}: FileTreeViewProps) {
  const [loaded, setLoaded] = useState<LoadedMap>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Map<string, string>>(new Map());
  const loadedRef = useRef<LoadedMap>(new Map());
  const loadingRef = useRef<Set<string>>(new Set());
  const scopeGenerationRef = useRef(0);
  const requestGenerationRef = useRef(new Map<string, number>());
  const reportedErrorsRef = useRef(new Map<string, string>());
  const previousRefreshKeyRef = useRef(refreshKey);
  const onToastRef = useRef(onToast);

  const root = rootPath ?? "";
  const rootLoaded = loaded.has(root);

  useEffect(() => {
    onToastRef.current = onToast;
  }, [onToast]);

  const updateLoaded = useCallback((updater: (current: LoadedMap) => LoadedMap) => {
    setLoaded((current) => {
      const next = updater(current);
      loadedRef.current = next;
      return next;
    });
  }, []);

  const updateLoading = useCallback((updater: (current: Set<string>) => Set<string>) => {
    setLoadingDirs((current) => {
      const next = updater(current);
      loadingRef.current = next;
      return next;
    });
  }, []);

  // A force refresh deliberately bypasses the cache but keeps its last good
  // value visible. Per-directory generations make "latest response wins"
  // deterministic when several saves arrive close together.
  const loadDir = useCallback(
    async (dirPath: string, force = false) => {
      if (!force && (loadedRef.current.has(dirPath) || loadingRef.current.has(dirPath))) return;
      const scopeGeneration = scopeGenerationRef.current;
      const requestGeneration = (requestGenerationRef.current.get(dirPath) ?? 0) + 1;
      requestGenerationRef.current.set(dirPath, requestGeneration);
      updateLoading((current) => new Set(current).add(dirPath));
      setErrors((current) => {
        if (!current.has(dirPath)) return current;
        const next = new Map(current);
        next.delete(dirPath);
        return next;
      });
      try {
        const entries = await listDir(dirPath, undefined, undefined, includeHidden);
        if (
          scopeGeneration !== scopeGenerationRef.current
          || requestGenerationRef.current.get(dirPath) !== requestGeneration
        ) return;
        updateLoaded((current) => {
          const next = new Map(current);
          next.set(dirPath, entries);
          return next;
        });
        reportedErrorsRef.current.delete(dirPath);
      } catch (e) {
        if (
          scopeGeneration !== scopeGenerationRef.current
          || requestGenerationRef.current.get(dirPath) !== requestGeneration
        ) return;
        const msg = String(e).replace(/^Error:\s*/, "");
        setErrors((current) => {
          if (current.get(dirPath) === msg) return current;
          const next = new Map(current);
          next.set(dirPath, msg);
          return next;
        });
        if (reportedErrorsRef.current.get(dirPath) !== msg) {
          reportedErrorsRef.current.set(dirPath, msg);
          onToastRef.current?.(`读取目录失败：${msg}`);
        }
      } finally {
        if (
          scopeGeneration === scopeGenerationRef.current
          && requestGenerationRef.current.get(dirPath) === requestGeneration
        ) {
          updateLoading((current) => {
            const next = new Set(current);
            next.delete(dirPath);
            return next;
          });
        }
      }
    },
    [updateLoaded, updateLoading],
  );

  // A workspace switch is the only operation that clears the visible tree.
  // Late responses from the old workspace are invalidated before state resets.
  useEffect(() => {
    scopeGenerationRef.current += 1;
    requestGenerationRef.current.clear();
    reportedErrorsRef.current.clear();
    loadedRef.current = new Map();
    loadingRef.current = new Set();
    setLoaded(loadedRef.current);
    setLoadingDirs(loadingRef.current);
    setExpanded(new Set());
    setErrors(new Map());
    previousRefreshKeyRef.current = refreshKey;
    if (!root) return;
    void loadDir(root, true);
  }, [loadDir, root]); // refreshKey is only snapshotted for the new root.

  // SP2: toggling "show hidden" must drop the cached entries because they may
  // now be missing (dotfile hidden) or duplicated (dotfile shown).
  const previousIncludeHiddenRef = useRef(includeHidden);
  useEffect(() => {
    if (!root) return;
    if (previousIncludeHiddenRef.current === includeHidden) return;
    previousIncludeHiddenRef.current = includeHidden;
    void loadDir(root, true);
  }, [includeHidden, loadDir, root]);

  // File writes refresh in the background. Existing entries and expansion
  // state stay mounted, so code generation never flashes an empty explorer.
  useEffect(() => {
    if (!root || previousRefreshKeyRef.current === refreshKey) return;
    previousRefreshKeyRef.current = refreshKey;
    const current = loadedRef.current;
    const targets = refreshPaths.length > 0
      ? new Set(refreshPaths.map((path) => closestLoadedParent(root, path, current)))
      : new Set(current.keys());
    if (targets.size === 0) targets.add(root);
    for (const dirPath of targets) void loadDir(dirPath, true);
  }, [loadDir, refreshKey, refreshPaths, root]);

  const toggleDir = useCallback(
    async (dirPath: string) => {
      const opening = !expanded.has(dirPath);
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(dirPath)) next.delete(dirPath);
        else next.add(dirPath);
        return next;
      });
      if (opening) await loadDir(dirPath);
    },
    [expanded, loadDir],
  );

  // Flatten visible tree for shift-click range selection. Must be defined
  // BEFORE any conditional return so the hook order is stable across renders.
  const rootEntries = root ? loaded.get(root) ?? [] : [];
  const visiblePaths = useMemo(() => {
    const out: string[] = [];
    const walk = (entries: DirEntry[] | undefined) => {
      if (!entries) return;
      for (const entry of entries) {
        out.push(entry.path);
        if (entry.kind === "directory" && expanded.has(entry.path)) {
          walk(loaded.get(entry.path));
        }
      }
    };
    walk(rootEntries);
    return out;
  }, [rootEntries, expanded, loaded]);

  // SP2: virtualisation + container size hooks must run before any early
  // return so the hook order is stable across renders.
  const treeRef = useRef<HTMLDivElement | null>(null);
  const listHandleRef = useRef<FixedSizeListHandle | null>(null);
  const containerHeight = useElementSize(treeRef, "height");
  const shouldVirtualize = rootEntries.length >= topLevelThreshold;

  if (!root) {
    return (
      <div className="file-tree__empty">未设置工作区目录（cwd）。</div>
    );
  }

  if (!rootLoaded && errors.has(root)) {
    return (
      <div className="file-tree__empty file-tree__error" role="alert">
        <span>无法读取工作区文件。</span>
        <button type="button" onClick={() => void loadDir(root, true)}>重试</button>
      </div>
    );
  }

  if (!rootLoaded) {
    return <div className="file-tree__empty">加载文件树中…</div>;
  }

  if (rootEntries.length === 0) {
    return <div className="file-tree__empty">这里还是空的，放些文件进来再开始吧。</div>;
  }

  const renderTreeNode = (entry: DirEntry) => {
    const rel = gitStatusByPath ? toWorkspaceRelative(root, entry.path) : null;
    const gitStatus = rel !== null ? gitStatusByPath?.get(rel) : undefined;
    return (
      <TreeNode
        key={entry.path}
        entry={entry}
        depth={0}
        expanded={expanded}
        loaded={loaded}
        loadingDirs={loadingDirs}
        errors={errors}
        selectedPath={selectedPath}
        selectedDirectoryPath={selectedDirectoryPath}
        cutPaths={cutPaths}
        renamingPath={renamingPath ?? null}
        visiblePaths={visiblePaths}
        gitStatus={gitStatus}
        onContextMenu={onContextMenu}
        onRenameSubmit={onRenameSubmit}
        onRenameCancel={onRenameCancel}
        onToggleDir={toggleDir}
        onRetryDir={(path) => void loadDir(path, true)}
        onFileSelect={onFileSelect}
        onDirectorySelect={onDirectorySelect}
      />
    );
  };

  return (
    <div
      ref={treeRef}
      className={"file-tree" + (shouldVirtualize ? " file-tree--virtual" : "")}
      role="tree"
      aria-label="工作区文件树"
      aria-busy={loadingDirs.size > 0 || undefined}
    >
      {shouldVirtualize && containerHeight && containerHeight > 0 ? (
        <FixedSizeList
          ref={listHandleRef}
          items={rootEntries}
          itemHeight={virtualItemHeight}
          height={containerHeight}
          renderItem={(entry) => renderTreeNode(entry)}
          getKey={(entry) => entry.path}
          ariaLabel="工作区文件树"
        />
      ) : (
        rootEntries.map((entry) => renderTreeNode(entry))
      )}
    </div>
  );
}

/** 单个树节点（目录或文件），递归渲染子目录。 */
function TreeNode({
  entry,
  depth,
  expanded,
  loaded,
  loadingDirs,
  errors,
  selectedPath,
  selectedDirectoryPath,
  cutPaths,
  renamingPath,
  visiblePaths,
  gitStatus,
  onContextMenu,
  onRenameSubmit,
  onRenameCancel,
  onToggleDir,
  onRetryDir,
  onFileSelect,
  onDirectorySelect,
}: {
  entry: DirEntry;
  depth: number;
  expanded: Set<string>;
  loaded: LoadedMap;
  loadingDirs: Set<string>;
  errors: Map<string, string>;
  selectedPath?: string;
  selectedDirectoryPath?: string;
  cutPaths?: Set<string>;
  renamingPath: string | null;
  visiblePaths: string[];
  gitStatus?: CodingGitFile;
  onContextMenu?: (event: React.MouseEvent, entry: DirEntry) => void;
  onRenameSubmit?: (path: string, newName: string) => Promise<void>;
  onRenameCancel?: () => void;
  onToggleDir: (path: string) => void;
  onRetryDir: (path: string) => void;
  onFileSelect: (path: string) => void;
  onDirectorySelect?: (path: string) => void;
}) {
  const isDir = entry.kind === "directory";
  const isExpanded = expanded.has(entry.path);
  const isSingleSelected =
    entry.path === selectedPath || (isDir && entry.path === selectedDirectoryPath);
  const isMultiSelected = useFileTreeSelectionStore(
    (s) => s.selectedPaths.has(entry.path) || isSingleSelected,
  );
  const isCut = cutPaths?.has(entry.path) ?? false;
  const isRenaming = renamingPath === entry.path;
  const children = isDir ? loaded.get(entry.path) : undefined;
  const childLoading = isDir && isExpanded && loadingDirs.has(entry.path);
  const childError = isDir && isExpanded ? errors.get(entry.path) : undefined;

  const handleClick = (event: React.MouseEvent) => {
    const sel = useFileTreeSelectionStore.getState();
    if (event.shiftKey) {
      if (sel.anchorPath && visiblePaths.length > 0) {
        sel.rangeSelect(visiblePaths, sel.anchorPath, entry.path);
      } else {
        sel.select([entry.path], entry.path);
      }
    } else if (event.metaKey || event.ctrlKey) {
      sel.toggle(entry.path);
    } else {
      sel.select([entry.path], entry.path);
    }
    if (isDir) {
      onDirectorySelect?.(entry.path);
      onToggleDir(entry.path);
    } else {
      onFileSelect(entry.path);
    }
  };

  const handleContextMenu = (event: React.MouseEvent) => {
    if (!onContextMenu) return;
    event.preventDefault();
    onContextMenu(event, entry);
  };

  // SP5: large / binary / symlink classification. Done here so the badges
  // and the dimmed title both see a single source of truth.
  const isSymlink = entry.kind === "symlink";
  const tip = (() => {
    if (isSymlink) return `符号链接：${entry.path}`;
    if (entry.isBinary) return `二进制文件（${entry.size} 字节），双击将无法打开`;
    if (entry.isLarge) return `大文件：${formatFileSize(entry.size)}，超过 2 MB`;
    return entry.path;
  })();

  const classes = [
    "file-tree__node",
    isDir ? "file-tree__node--dir" : "file-tree__node--file",
    isSymlink ? "file-tree__node--disabled" : "",
    isMultiSelected ? "file-tree__node--selected" : "",
    isCut ? "file-tree__node--cut" : "",
    isRenaming ? "file-tree__node--renaming" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <>
      <div
        className={classes}
        style={{ paddingInlineStart: `${depth * 14 + 8}px` }}
        role="treeitem"
        aria-expanded={isDir ? isExpanded : undefined}
        aria-selected={isMultiSelected}
        data-cut={isCut || undefined}
        draggable
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        onDragStart={(event) => {
          // SP4: file tree → Composer / AgentPane drag bridge. Carry the
          // (possibly multi-select) paths in our own MIME so receivers can
          // round-trip them without touching Tauri events.
          const sel = useFileTreeSelectionStore.getState().selectedPaths;
          const paths = sel.has(entry.path) ? [...sel] : [entry.path];
          event.dataTransfer.setData(
            "application/x-echo-paths",
            JSON.stringify(paths),
          );
          // Fallback for components that only inspect text/plain.
          event.dataTransfer.setData("text/plain", paths.join("\n"));
          event.dataTransfer.effectAllowed = "copy";
        }}
        title={tip}
      >
        {isDir ? (
          <ChevronRightIcon
            size="sm"
            className={
              "file-tree__chevron" + (isExpanded ? " file-tree__chevron--open" : "")
            }
          />
        ) : (
          <span className="file-tree__chevron-placeholder" />
        )}
        <span className="file-tree__icon file-tree__icon--svg">
          <FileTypeIcon name={entry.name} kind={isDir ? "directory" : "file"} size={14} />
        </span>
        {isRenaming && onRenameSubmit && onRenameCancel ? (
          <InlineRenameField
            initialName={entry.name}
            onSubmit={(name) => onRenameSubmit(entry.path, name)}
            onCancel={onRenameCancel}
          />
        ) : (
          <>
            <span className="file-tree__name">{entry.name}</span>
            {/* SP5: large / binary / symlink badges, in priority order */}
            {!isSymlink && entry.isLarge ? (
              <span
                className="file-tree__large-badge"
                title={`大文件：${formatFileSize(entry.size)}`}
                data-testid="file-tree-large-badge"
              >
                L
              </span>
            ) : null}
            {!isSymlink && entry.isBinary ? (
              <span
                className="file-tree__binary-badge"
                title="二进制文件，AI 评审会跳过"
                data-testid="file-tree-binary-badge"
              >
                B
              </span>
            ) : null}
            {isSymlink ? (
              <span
                className="file-tree__symlink-badge"
                title="符号链接"
                data-testid="file-tree-symlink-badge"
              >
                ↪
              </span>
            ) : null}
          </>
        )}
        {gitStatus && !isRenaming ? (
          <span
            className={`file-tree__git-badge file-tree__git-badge--${gitStatus.status}`}
            title={gitStatusTooltip(gitStatus)}
          >
            {letterForGitStatus(gitStatus.status)}
          </span>
        ) : null}
      </div>
      {isDir &&
        isExpanded &&
        children &&
        children.map((child) => (
          <TreeNode
            key={child.path}
            entry={child}
            depth={depth + 1}
            expanded={expanded}
            loaded={loaded}
            loadingDirs={loadingDirs}
            errors={errors}
            selectedPath={selectedPath}
            selectedDirectoryPath={selectedDirectoryPath}
            cutPaths={cutPaths}
            renamingPath={renamingPath}
            visiblePaths={visiblePaths}
            onContextMenu={onContextMenu}
            onRenameSubmit={onRenameSubmit}
            onRenameCancel={onRenameCancel}
            onToggleDir={onToggleDir}
            onRetryDir={onRetryDir}
            onFileSelect={onFileSelect}
            onDirectorySelect={onDirectorySelect}
          />
        ))}
      {childLoading && (
        <div
          className="file-tree__node file-tree__node--loading"
          style={{ paddingInlineStart: `${(depth + 1) * 14 + 8}px` }}
        >
          …
        </div>
      )}
      {childError && !childLoading && (
        <button
          type="button"
          className="file-tree__retry"
          style={{ paddingInlineStart: `${(depth + 1) * 14 + 8}px` }}
          onClick={(event) => {
            event.stopPropagation();
            onRetryDir(entry.path);
          }}
          title={childError}
        >
          读取失败，点击重试
        </button>
      )}
    </>
  );
}
