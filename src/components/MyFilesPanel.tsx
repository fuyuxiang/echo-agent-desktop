import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDownIcon } from "@/foundation/components/Icon/icons";
import {
  SearchIcon,
  FolderOpenIcon,
  MyFilesIconV2,
  BookIcon,
  RefreshCwIcon,
} from "@/foundation/components/Icon/icons";
import { FileText, FileSpreadsheet, FileImage, FileCode, Film, Music, Globe, File, FolderOpen } from "lucide-react";
import { listDir, openLocalPath } from "@/lib/agent-client";
import { formatFileSize, inferFileTypeFromExt, relativeTime, type FileType, type LocalFileItem } from "@/lib/file-utils";
import {
  ARTIFACT_CATALOG_EVENT,
  artifactsFromTranscripts,
  loadTaskArtifacts,
  mergeTaskArtifacts,
} from "@/lib/artifact-catalog";
import { useSessionStore } from "@/stores/session-store";
import { useSessionsStore } from "@/stores/sessions-store";

function FileTypeIcon({ type, size = 16 }: { type: FileType; size?: number }) {
  switch (type) {
    case "folder": return <FolderOpen size={size} />;
    case "document": case "markdown": return <FileText size={size} />;
    case "spreadsheet": return <FileSpreadsheet size={size} />;
    case "image": return <FileImage size={size} />;
    case "code": return <FileCode size={size} />;
    case "video": return <Film size={size} />;
    case "audio": return <Music size={size} />;
    case "website": return <Globe size={size} />;
    default: return <File size={size} />;
  }
}

const FILE_TYPE_FILTERS: { value: string; label: string }[] = [
  { value: "all", label: "全部类型" },
  { value: "document", label: "文档" },
  { value: "markdown", label: "Markdown" },
  { value: "spreadsheet", label: "表格" },
  { value: "image", label: "图片" },
  { value: "code", label: "代码" },
  { value: "pdf", label: "PDF" },
  { value: "other", label: "其他" },
];

interface MyFilesPanelProps {
  cwd?: string;
  onToast?: (msg: string) => void;
}

export function MyFilesPanel({ cwd, onToast }: MyFilesPanelProps) {
  const [tab, setTab] = useState<"artifacts" | "local">("artifacts");
  const [searchQuery, setSearchQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [filterOpen, setFilterOpen] = useState(false);

  return (
    <div className="myfiles-panel">
      <div className="myfiles-header">
        <h2 className="myfiles-title">我的文件</h2>
        <p className="myfiles-subtitle">
          集中查看任务生成的成果与当前工作空间文件。云端同步请前往「网络存储」。
        </p>
      </div>

      <div className="myfiles-tabs">
        <button
          className={`myfiles-tab ${tab === "artifacts" ? "myfiles-tab--active" : ""}`}
          onClick={() => setTab("artifacts")}
        >
          <BookIcon size="sm" /> 任务成果
        </button>
        <button
          className={`myfiles-tab ${tab === "local" ? "myfiles-tab--active" : ""}`}
          onClick={() => setTab("local")}
        >
          <FolderOpenIcon size="sm" /> 本地文件
        </button>
      </div>

      <div className="myfiles-toolbar">
        <div className="myfiles-filter-wrap">
          <button
            className="myfiles-filter-btn"
            onClick={() => setFilterOpen(!filterOpen)}
          >
            全部类型 <ChevronDownIcon size="sm" style={{ verticalAlign: "text-bottom" }} />
          </button>
          {filterOpen && (
            <div className="myfiles-filter-dropdown">
              {FILE_TYPE_FILTERS.map((f) => (
                <button
                  key={f.value}
                  className={`myfiles-filter-option ${typeFilter === f.value ? "myfiles-filter-option--active" : ""}`}
                  onClick={() => { setTypeFilter(f.value); setFilterOpen(false); }}
                >
                  {f.label}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="myfiles-search">
          <SearchIcon size="sm" />
          <input
            type="text"
            placeholder="搜索文件、任务或工作空间"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
      </div>

      <div className="myfiles-body">
        {tab === "artifacts" ? (
          <ArtifactsTab
            cwd={cwd}
            searchQuery={searchQuery}
            typeFilter={typeFilter}
            onToast={onToast}
          />
        ) : (
          <LocalFilesTab
            cwd={cwd}
            searchQuery={searchQuery}
            typeFilter={typeFilter}
            onToast={onToast}
          />
        )}
      </div>
    </div>
  );
}

function ArtifactsTab({
  cwd,
  searchQuery,
  typeFilter,
  onToast,
}: {
  cwd?: string;
  searchQuery: string;
  typeFilter: string;
  onToast?: (msg: string) => void;
}) {
  const transcripts = useSessionStore((state) => state.transcripts);
  const independent = useSessionsStore((state) => state.independent);
  const workspaceSessions = useSessionsStore((state) => state.workspaceSessions);
  const [catalogVersion, setCatalogVersion] = useState(0);

  useEffect(() => {
    const refresh = () => setCatalogVersion((version) => version + 1);
    window.addEventListener(ARTIFACT_CATALOG_EVENT, refresh);
    return () => window.removeEventListener(ARTIFACT_CATALOG_EVENT, refresh);
  }, []);

  const entries = useMemo(() => {
    const sessions = [...independent, ...Object.values(workspaceSessions).flat()];
    const meta = Object.fromEntries(sessions.map((session) => [
      session.sessionId,
      {
        title: session.title,
        cwd: session.cwd,
        updatedAt: session.updatedAt ? Date.parse(session.updatedAt) || 0 : 0,
      },
    ]));
    return mergeTaskArtifacts(
      artifactsFromTranscripts(transcripts, meta),
      loadTaskArtifacts(),
    );
  }, [catalogVersion, independent, transcripts, workspaceSessions]);

  const filtered = entries.filter((e) => {
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      if (!e.path.toLowerCase().includes(q)
        && !e.sessionTitle.toLowerCase().includes(q)
        && !e.cwd.toLowerCase().includes(q))
        return false;
    }
    if (typeFilter !== "all") {
      const ft = inferFileTypeFromExt(e.path);
      if (ft !== typeFilter) return false;
    }
    return true;
  });

  if (filtered.length === 0) {
    return (
      <div className="myfiles-empty">
        <MyFilesIconV2 size="xl" />
        <p>{entries.length === 0 ? "尚未发现任务生成的文件" : "没有匹配的任务成果"}</p>
        <span className="myfiles-empty-hint">完成文件写入或编辑任务后，成果会自动收录。打开历史会话可回填旧成果。</span>
        <button className="myfiles-empty-btn" onClick={() => setCatalogVersion((version) => version + 1)}>
          <RefreshCwIcon size="sm" /> 刷新
        </button>
      </div>
    );
  }

  return (
    <div className="myfiles-table">
      <div className="myfiles-table-head">
        <span className="myfiles-col-name">名称</span>
        <span className="myfiles-col-task">所属任务</span>
        <span className="myfiles-col-scope">工作空间</span>
        <span className="myfiles-col-time">更新时间</span>
      </div>
      {filtered.map((entry) => {
        const ft = inferFileTypeFromExt(entry.path);
        return (
          <div
            key={`${entry.sessionId}/${entry.path}`}
            className="myfiles-row myfiles-row--artifact"
            title={entry.path}
            onClick={() => void openLocalPath(entry.path, entry.cwd || cwd).catch((error) => {
              onToast?.(`打开成果失败：${String(error).replace(/^Error:\s*/, "")}`);
            })}
            role="button"
            tabIndex={0}
            aria-label={`打开成果 ${entry.path}`}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              void openLocalPath(entry.path, entry.cwd || cwd).catch((error) => {
                onToast?.(`打开成果失败：${String(error).replace(/^Error:\s*/, "")}`);
              });
            }}
          >
            <span className="myfiles-col-name">
              <FileTypeIcon type={ft} size={18} />
              <span className="myfiles-row-name">{entry.path}</span>
            </span>
            <span className="myfiles-col-task" title={entry.sessionTitle}>{entry.sessionTitle}</span>
            <span className="myfiles-col-scope">
              {entry.cwd ? entry.cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop() : "默认空间"}
            </span>
            <span className="myfiles-col-time">{relativeTime(entry.updatedAt)}</span>
          </div>
        );
      })}
    </div>
  );
}

function LocalFilesTab({
  cwd,
  searchQuery,
  typeFilter,
  onToast,
}: {
  cwd?: string;
  searchQuery: string;
  typeFilter: string;
  onToast?: (msg: string) => void;
}) {
  const [files, setFiles] = useState<LocalFileItem[]>([]);
  const [breadcrumb, setBreadcrumb] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadedDir, setLoadedDir] = useState<string | null>(null);
  const loadGenerationRef = useRef(0);
  const currentDir = breadcrumb.length > 0 ? breadcrumb[breadcrumb.length - 1] : (cwd || "");

  const loadDir = useCallback(async (dir: string) => {
    if (!dir) return;
    const generation = ++loadGenerationRef.current;
    setLoading(true);
    try {
      const entries = await listDir(dir, cwd, 2000);
      const items: LocalFileItem[] = entries.map((e) => ({
        name: e.name,
        path: e.path,
        isDir: e.kind === "directory",
        size: e.size,
        modifiedAt: e.modifiedAt,
        type: inferFileTypeFromExt(e.name, e.kind === "directory"),
      }));
      items.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      if (loadGenerationRef.current !== generation) return;
      setFiles(items);
      setLoadedDir(dir);
      setError(null);
    } catch (cause) {
      if (loadGenerationRef.current !== generation) return;
      setError(String(cause).replace(/^Error:\s*/, ""));
      onToast?.("读取目录失败，请检查目录是否存在且可读");
    } finally {
      if (loadGenerationRef.current === generation) setLoading(false);
    }
  }, [cwd, onToast]);

  useEffect(() => {
    setBreadcrumb([]);
  }, [cwd]);

  useEffect(() => {
    if (currentDir) void loadDir(currentDir);
    else {
      setFiles([]);
      setLoadedDir(null);
      setError(null);
      setLoading(false);
    }
    return () => {
      loadGenerationRef.current += 1;
    };
  }, [currentDir, loadDir]);

  const handleEnterFolder = (path: string) => {
    setBreadcrumb((prev) => [...prev, path]);
  };

  const handleBreadcrumbClick = (index: number) => {
    setBreadcrumb((prev) => prev.slice(0, index + 1));
  };

  const handleOpenCurrentDir = async () => {
    if (!currentDir) return;
    try {
      await openLocalPath(currentDir, cwd);
    } catch (error) {
      onToast?.(`打开目录失败：${String(error).replace(/^Error:\s*/, "")}`);
    }
  };

  const filtered = files.filter((f) => {
    if (searchQuery) {
      if (!f.name.toLowerCase().includes(searchQuery.toLowerCase())) return false;
    }
    if (typeFilter !== "all" && !f.isDir) {
      if (f.type !== typeFilter) return false;
    }
    return true;
  });

  return (
    <div className="myfiles-local">
      <div className="myfiles-local-toolbar">
        <button className="myfiles-action-btn" onClick={() => void handleOpenCurrentDir()} disabled={!currentDir}>
          <FolderOpenIcon size="sm" /> 在系统中打开当前目录
        </button>
        <button className="myfiles-action-btn" onClick={() => loadDir(currentDir)}>
          <RefreshCwIcon size="sm" /> 刷新
        </button>
      </div>

      {breadcrumb.length > 0 && (
        <div className="myfiles-breadcrumb">
          <button
            className="myfiles-breadcrumb-item"
            onClick={() => setBreadcrumb([])}
          >
            根目录
          </button>
          {breadcrumb.map((p, i) => {
            const name = p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;
            return (
              <span key={i}>
                <span className="myfiles-breadcrumb-sep">/</span>
                <button
                  className="myfiles-breadcrumb-item"
                  onClick={() => handleBreadcrumbClick(i)}
                >
                  {name}
                </button>
              </span>
            );
          })}
        </div>
      )}

      {loading && <div className="myfiles-empty">加载中…</div>}

      {!loading && error && (
        <div className="myfiles-empty" role="alert">
          <p>读取目录失败：{error}</p>
          <button className="myfiles-empty-btn" type="button" onClick={() => void loadDir(currentDir)}>
            <RefreshCwIcon size="sm" /> 重试
          </button>
        </div>
      )}

      {!loading && !currentDir && (
        <div className="myfiles-empty">
          <FolderOpenIcon size="xl" />
          <p>请先选择一个工作空间目录</p>
        </div>
      )}

      {!loading && !error && currentDir && filtered.length === 0 && (
        <div className="myfiles-empty">
          <MyFilesIconV2 size="xl" />
          <p>暂无文件</p>
        </div>
      )}

      {!loading && filtered.length > 0 && (!error || loadedDir === currentDir) && (
        <div className="myfiles-table">
          <div className="myfiles-table-head">
            <span className="myfiles-col-name">名称</span>
            <span className="myfiles-col-type">类型</span>
            <span className="myfiles-col-time">更新时间</span>
            <span className="myfiles-col-size">大小</span>
          </div>
          {filtered.map((file) => (
            <div
              key={file.path}
              className={`myfiles-row ${file.isDir ? "myfiles-row--folder" : ""}`}
              onClick={() => {
                if (file.isDir) handleEnterFolder(file.path);
                else void openLocalPath(file.path, cwd).catch((error) => {
                  onToast?.(`打开文件失败：${String(error).replace(/^Error:\s*/, "")}`);
                });
              }}
              role="button"
              tabIndex={0}
              aria-label={`${file.isDir ? "打开文件夹" : "打开文件"} ${file.name}`}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                if (file.isDir) handleEnterFolder(file.path);
                else void openLocalPath(file.path, cwd).catch((cause) => {
                  onToast?.(`打开文件失败：${String(cause).replace(/^Error:\s*/, "")}`);
                });
              }}
            >
              <span className="myfiles-col-name">
                <FileTypeIcon type={file.type} size={18} />
                <span className="myfiles-row-name">{file.name}</span>
              </span>
              <span className="myfiles-col-type">
                {file.isDir ? "文件夹" : file.type}
              </span>
              <span className="myfiles-col-time">
                {relativeTime(file.modifiedAt)}
              </span>
              <span className="myfiles-col-size">
                {file.isDir ? "-" : formatFileSize(file.size)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
