/**
 * 文件树视图 —— 对齐 EchoAgent `context-viewer-components/DetailPanel/FileTree`。
 *
 * 左列：可展开/折叠的目录树（懒加载 `listDir`，展开时按需拉取子目录）。
 * 选中文件由父组件通过 onFileSelect 回调驱动主区域预览。
 *
 * 根目录取 cwd（会话工作区）。隐藏/构建目录已在后端过滤。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { listDir, type DirEntry } from "@/lib/agent-client";
import { pickFileEmoji } from "./file-tab-icon";
import { ChevronRightIcon } from "@/foundation/components/Icon/icons";

/** 已加载的目录条目缓存：path → entries。 */
type LoadedMap = Map<string, DirEntry[]>;

function normalize(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
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
        const entries = await listDir(dirPath);
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

  const rootEntries = loaded.get(root) ?? [];
  if (rootEntries.length === 0) {
    return <div className="file-tree__empty">这里还是空的，放些文件进来再开始吧。</div>;
  }

  return (
    <div
      className="file-tree"
      role="tree"
      aria-label="工作区文件树"
      aria-busy={loadingDirs.size > 0 || undefined}
    >
      {rootEntries.map((entry) => (
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
          onToggleDir={toggleDir}
          onRetryDir={(path) => void loadDir(path, true)}
          onFileSelect={onFileSelect}
          onDirectorySelect={onDirectorySelect}
        />
      ))}
      {rootEntries.length === 0 && (
        <div className="file-tree__empty">选择文件查看内容</div>
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
  onToggleDir: (path: string) => void;
  onRetryDir: (path: string) => void;
  onFileSelect: (path: string) => void;
  onDirectorySelect?: (path: string) => void;
}) {
  const isDir = entry.kind === "directory";
  const isExpanded = expanded.has(entry.path);
  const isSelected = entry.path === selectedPath || (isDir && entry.path === selectedDirectoryPath);
  const children = isDir ? loaded.get(entry.path) : undefined;
  const childLoading = isDir && isExpanded && loadingDirs.has(entry.path);
  const childError = isDir && isExpanded ? errors.get(entry.path) : undefined;

  const handleClick = () => {
    if (isDir) {
      onDirectorySelect?.(entry.path);
      onToggleDir(entry.path);
    }
    else onFileSelect(entry.path);
  };

  return (
    <>
      <div
        className={
          "file-tree__node" +
          (isDir ? " file-tree__node--dir" : " file-tree__node--file") +
          (isSelected ? " file-tree__node--selected" : "")
        }
        style={{ paddingInlineStart: `${depth * 14 + 8}px` }}
        role="treeitem"
        aria-expanded={isDir ? isExpanded : undefined}
        aria-selected={isSelected}
        onClick={handleClick}
        title={entry.path}
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
        <span className="file-tree__icon">
          {isDir ? "📁" : pickFileEmoji(entry.name)}
        </span>
        <span className="file-tree__name">{entry.name}</span>
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
