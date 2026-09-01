/**
 * 云存储浏览面板 —— 腾讯 Drive/文档 替代的 UI。
 *
 * 列出已注册的 WebDAV 存储源，并提供浏览、读取、写入与删除操作。
 */
import { useEffect, useState } from "react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  hydrateStorageProviders,
  saveStorageProviderConfig,
  removeStorageProviderConfig,
  testStorageProviderConfig,
  createTauriWebDavProvider,
  registerStorageProvider,
  unregisterStorageProvider,
  listStorageProviders,
  getStorageProvider,
  joinStoragePath,
  normalizePath,
  type StorageEntry,
  type StorageProviderConfig,
} from "@/lib/cloud-storage";

export function CloudStoragePanel({ onToast }: { onToast?: (msg: string) => void }) {
  const [providers, setProviders] = useState<Array<{ id: string; label: string }>>([]);
  const [configs, setConfigs] = useState<StorageProviderConfig[]>([]);
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const [entries, setEntries] = useState<StorageEntry[]>([]);
  const [currentPath, setCurrentPath] = useState("/");
  const [loading, setLoading] = useState(false);
  const [showConfig, setShowConfig] = useState(false);
  const [preview, setPreview] = useState<{ name: string; path: string; content: string } | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [draft, setDraft] = useState<StorageProviderConfig>({
    id: "",
    label: "",
    kind: "webdav",
    baseUrl: "",
    username: "",
    password: "",
    enabled: true,
  });

  useEffect(() => {
    let cancelled = false;
    void hydrateStorageProviders()
      .then((loaded) => {
        if (!cancelled) {
          setConfigs(loaded);
          setProviders(listStorageProviders());
        }
      })
      .catch((error) => onToast?.(`读取存储配置失败：${String(error).replace(/^Error:\s*/, "")}`));
    return () => { cancelled = true; };
  }, [onToast]);

  const saveConfig = async () => {
    const id = draft.id.trim() || `webdav-${Date.now()}`;
    const config = { ...draft, id, label: draft.label.trim() || "WebDAV", baseUrl: draft.baseUrl.trim() };
    try {
      await saveStorageProviderConfig(config);
      registerStorageProvider(createTauriWebDavProvider(config));
      setConfigs((current) => [...current.filter((item) => item.id !== config.id), config]);
      setProviders(listStorageProviders());
      if (!config.enabled && selectedProvider === config.id) {
        setSelectedProvider(null);
        setEntries([]);
      }
      setDraft({ id: "", label: "", kind: "webdav", baseUrl: "", username: "", password: "", enabled: true });
      setShowConfig(false);
      onToast?.("WebDAV 存储源已保存");
    } catch (error) {
      onToast?.(`保存失败：${String(error).replace(/^Error:\s*/, "")}`);
    }
  };

  const removeConfig = async () => {
    if (!selectedProvider || !window.confirm("确定移除当前存储源配置吗？远端文件不会被删除。")) return;
    try {
      await removeStorageProviderConfig(selectedProvider);
      unregisterStorageProvider(selectedProvider);
      setConfigs((current) => current.filter((item) => item.id !== selectedProvider));
      setProviders(listStorageProviders());
      setSelectedProvider(null);
      setEntries([]);
      onToast?.("已移除存储源");
    } catch (error) {
      onToast?.(`移除失败：${String(error).replace(/^Error:\s*/, "")}`);
    }
  };

  const browse = async (providerId: string, path: string) => {
    const provider = getStorageProvider(providerId);
    if (!provider) return;
    setLoading(true);
    try {
      const list = await provider.list(normalizePath(path));
      setEntries(list.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1)));
      setCurrentPath(normalizePath(path));
    } catch (e) {
      onToast?.(`浏览失败：${String(e).replace(/^Error:\s*/, "")}`);
      setEntries([]);
    } finally {
      setLoading(false);
    }
  };

  const selectProvider = (id: string) => {
    setSelectedProvider(id);
    void browse(id, "/");
  };

  const openEntry = (entry: StorageEntry) => {
    if (entry.isDir && selectedProvider) {
      void browse(selectedProvider, entry.path);
    }
  };

  const goUp = () => {
    if (!selectedProvider) return;
    const parts = currentPath.split("/").filter(Boolean);
    parts.pop();
    void browse(selectedProvider, "/" + parts.join("/"));
  };

  const deleteEntry = async (entry: StorageEntry) => {
    if (!selectedProvider) return;
    const provider = getStorageProvider(selectedProvider);
    if (!provider) return;
    if (!window.confirm(`确定删除“${entry.name}”吗？此操作会修改远端存储。`)) return;
    try {
      const ok = await provider.delete(entry.path);
      if (!ok) throw new Error("服务端拒绝删除");
      onToast?.(`已删除 ${entry.name}`);
      void browse(selectedProvider, currentPath);
    } catch (e) {
      onToast?.(`删除失败：${String(e).replace(/^Error:\s*/, "")}`);
    }
  };

  const readFile = async (entry: StorageEntry) => {
    if (!selectedProvider) return;
    const provider = getStorageProvider(selectedProvider);
    if (!provider) return;
    try {
      const content = await provider.readText(entry.path);
      if (content != null) {
        setPreview({ name: entry.name, path: entry.path, content });
      } else {
        onToast?.("(空文件或二进制)");
      }
    } catch (error) {
      onToast?.(`读取失败：${String(error).replace(/^Error:\s*/, "")}`);
    }
  };

  const beginNewConfig = () => {
    setDraft({ id: "", label: "", kind: "webdav", baseUrl: "", username: "", password: "", enabled: true });
    setShowConfig(true);
  };

  const editSelectedConfig = () => {
    const config = configs.find((item) => item.id === selectedProvider);
    if (!config) return;
    setDraft({ ...config });
    setShowConfig(true);
  };

  const uploadFiles = async () => {
    if (!selectedProvider) return;
    const provider = getStorageProvider(selectedProvider);
    if (!provider?.uploadFile) return;
    try {
      const picked = await openDialog({ multiple: true, directory: false });
      const paths = !picked ? [] : Array.isArray(picked) ? picked : [picked];
      if (paths.length === 0) return;
      const existing = new Set(entries.filter((entry) => !entry.isDir).map((entry) => entry.name));
      const conflicts = paths.filter((path) => existing.has(localBasename(path))).length;
      if (conflicts > 0 && !window.confirm(`${conflicts} 个同名文件将被覆盖，是否继续？`)) return;
      setBusyAction("上传中…");
      for (const localPath of paths) {
        await provider.uploadFile(joinStoragePath(currentPath, localBasename(localPath)), localPath);
      }
      await browse(selectedProvider, currentPath);
      onToast?.(`已上传 ${paths.length} 个文件`);
    } catch (error) {
      onToast?.(`上传失败：${String(error).replace(/^Error:\s*/, "")}`);
    } finally {
      setBusyAction(null);
    }
  };

  const downloadFile = async (entry: StorageEntry) => {
    if (!selectedProvider) return;
    const provider = getStorageProvider(selectedProvider);
    if (!provider?.downloadFile) return;
    try {
      const destination = await saveDialog({ defaultPath: entry.name });
      if (!destination) return;
      setBusyAction("下载中…");
      const bytes = await provider.downloadFile(entry.path, destination);
      onToast?.(`已下载 ${formatSize(bytes)}`);
    } catch (error) {
      onToast?.(`下载失败：${String(error).replace(/^Error:\s*/, "")}`);
    } finally {
      setBusyAction(null);
    }
  };

  const savePreview = async () => {
    if (!selectedProvider || !preview) return;
    setBusyAction("保存中…");
    try {
      const ok = await getStorageProvider(selectedProvider)?.writeText(preview.path, preview.content);
      if (!ok) throw new Error("写入失败");
      await browse(selectedProvider, currentPath);
      onToast?.("文本已保存");
    } catch (error) {
      onToast?.(`保存失败：${String(error).replace(/^Error:\s*/, "")}`);
    } finally {
      setBusyAction(null);
    }
  };

  const createFolder = async () => {
    if (!selectedProvider) return;
    const name = window.prompt("新文件夹名称")?.trim();
    if (!name) return;
    try {
      const ok = await getStorageProvider(selectedProvider)?.makeDir(`${currentPath}/${name}`);
      if (!ok) throw new Error("创建失败");
      await browse(selectedProvider, currentPath);
      onToast?.("文件夹已创建");
    } catch (error) {
      onToast?.(`创建失败：${String(error).replace(/^Error:\s*/, "")}`);
    }
  };

  const createTextFile = async () => {
    if (!selectedProvider) return;
    const name = window.prompt("文本文件名", "note.md")?.trim();
    if (!name) return;
    const content = window.prompt("文件内容", "") ?? "";
    try {
      const ok = await getStorageProvider(selectedProvider)?.writeText(`${currentPath}/${name}`, content);
      if (!ok) throw new Error("写入失败");
      await browse(selectedProvider, currentPath);
      onToast?.("文件已写入");
    } catch (error) {
      onToast?.(`写入失败：${String(error).replace(/^Error:\s*/, "")}`);
    }
  };

  return (
    <div className="storage-panel" role="region" aria-label="云存储">
      <div className="storage-panel__head">
        <span className="storage-panel__title">云存储</span>
        {providers.length > 0 ? (
          <select value={selectedProvider ?? ""} onChange={(e) => selectProvider(e.target.value)}>
            <option value="">选择存储源…</option>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </select>
        ) : (
          <span className="storage-panel__muted">未配置存储源</span>
        )}
        <div className="storage-panel__head-actions">
          <button type="button" onClick={beginNewConfig}>+ WebDAV</button>
          {selectedProvider && <button type="button" onClick={editSelectedConfig}>编辑配置</button>}
          {selectedProvider && <button type="button" className="danger" onClick={() => void removeConfig()}>移除配置</button>}
        </div>
      </div>

      {showConfig && (
        <div className="storage-panel__config">
          <strong>{draft.id ? "编辑 WebDAV" : "添加 WebDAV"}</strong>
          <input value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} placeholder="显示名" />
          <input value={draft.baseUrl} onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })} placeholder="https://dav.example.com/path" />
          <input value={draft.username ?? ""} onChange={(e) => setDraft({ ...draft, username: e.target.value })} placeholder="用户名（可选）" />
          <input type="password" value={draft.password ?? ""} onChange={(e) => setDraft({ ...draft, password: e.target.value })} placeholder="密码/应用令牌（可选）" />
          <label className="storage-panel__enabled"><input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} /> 启用此存储源</label>
          <div className="storage-panel__config-actions">
            <button type="button" onClick={() => setShowConfig(false)}>取消</button>
            <button type="button" onClick={() => void saveConfig()} disabled={!draft.baseUrl.trim()}>保存</button>
          </div>
        </div>
      )}

      {/* 面包屑 */}
      {selectedProvider && (
        <div className="storage-panel__breadcrumb">
          {currentPath !== "/" && (
            <button type="button" onClick={goUp} className="storage-panel__up">↑ 上级</button>
          )}
          <span className="storage-panel__path">{currentPath}</span>
          <button type="button" onClick={() => void createFolder()}>新建文件夹</button>
          <button type="button" onClick={() => void createTextFile()}>新建文本</button>
          <button type="button" onClick={() => void uploadFiles()} disabled={!!busyAction}>
            {busyAction === "上传中…" ? busyAction : "上传文件"}
          </button>
          <button type="button" onClick={() => void testStorageProviderConfig(selectedProvider).then(() => onToast?.("连接正常")).catch((e) => onToast?.(`连接失败：${String(e).replace(/^Error:\s*/, "")}`))}>测试连接</button>
        </div>
      )}

      {/* 文件列表 */}
      {loading ? (
        <div className="storage-panel__loading">加载中…</div>
      ) : selectedProvider && entries.length > 0 ? (
        <ul className="storage-panel__list">
          {entries.map((e) => (
            <li key={e.path} className={"storage-panel__entry" + (e.isDir ? " dir" : "")}>
              <span className="storage-panel__entry-icon">{e.isDir ? "📁" : "📄"}</span>
              <span className="storage-panel__entry-name" onClick={() => openEntry(e)} title={e.isDir ? "打开目录" : undefined}>
                {e.name}
              </span>
              {!e.isDir && e.size != null && (
                <span className="storage-panel__entry-size">{formatSize(e.size)}</span>
              )}
              <div className="storage-panel__entry-actions">
                {!e.isDir && (
                  <button type="button" onClick={() => void readFile(e)} title="读取" aria-label={`读取 ${e.name}`}>👁</button>
                )}
                {!e.isDir && (
                  <button type="button" onClick={() => void downloadFile(e)} title="下载" aria-label={`下载 ${e.name}`} disabled={!!busyAction}>↓</button>
                )}
                <button type="button" onClick={() => void deleteEntry(e)} title="删除" aria-label={`删除 ${e.name}`} className="danger">🗑</button>
              </div>
            </li>
          ))}
        </ul>
      ) : selectedProvider && !loading ? (
        <div className="storage-panel__empty">空目录</div>
      ) : null}
      {preview && (
        <div className="storage-panel__preview">
          <div>
            <strong>{preview.name}</strong>
            <span>
              <button type="button" onClick={() => void savePreview()} disabled={!!busyAction}>{busyAction === "保存中…" ? busyAction : "保存"}</button>
              <button type="button" onClick={() => setPreview(null)}>关闭</button>
            </span>
          </div>
          <textarea value={preview.content} onChange={(event) => setPreview({ ...preview, content: event.target.value })} aria-label={`编辑 ${preview.name}`} />
        </div>
      )}
    </div>
  );
}

function localBasename(path: string): string {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "upload";
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${bytes}B`;
}
