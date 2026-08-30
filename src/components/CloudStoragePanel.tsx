/**
 * 云存储浏览面板 —— 腾讯 Drive/文档 替代的 UI。
 *
 * 列出已注册的 WebDAV 存储源，并提供浏览、读取、写入与删除操作。
 */
import { useEffect, useState } from "react";
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
  normalizePath,
  type StorageEntry,
  type StorageProviderConfig,
} from "@/lib/cloud-storage";

export function CloudStoragePanel({ onToast }: { onToast?: (msg: string) => void }) {
  const [providers, setProviders] = useState<Array<{ id: string; label: string }>>([]);
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const [entries, setEntries] = useState<StorageEntry[]>([]);
  const [currentPath, setCurrentPath] = useState("/");
  const [loading, setLoading] = useState(false);
  const [showConfig, setShowConfig] = useState(false);
  const [preview, setPreview] = useState<{ name: string; content: string } | null>(null);
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
      .then(() => { if (!cancelled) setProviders(listStorageProviders()); })
      .catch((error) => onToast?.(`读取存储配置失败：${String(error).replace(/^Error:\s*/, "")}`));
    return () => { cancelled = true; };
  }, [onToast]);

  const saveConfig = async () => {
    const id = draft.id.trim() || `webdav-${Date.now()}`;
    const config = { ...draft, id, label: draft.label.trim() || "WebDAV", baseUrl: draft.baseUrl.trim() };
    try {
      await saveStorageProviderConfig(config);
      registerStorageProvider(createTauriWebDavProvider(config));
      setProviders(listStorageProviders());
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
        setPreview({ name: entry.name, content });
      } else {
        onToast?.("(空文件或二进制)");
      }
    } catch {
      onToast?.("读取失败");
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
        <button type="button" onClick={() => setShowConfig((value) => !value)}>+ WebDAV</button>
        {selectedProvider && <button type="button" className="danger" onClick={() => void removeConfig()}>移除配置</button>}
      </div>

      {showConfig && (
        <div className="storage-panel__config">
          <input value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} placeholder="显示名" />
          <input value={draft.baseUrl} onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })} placeholder="https://dav.example.com/path" />
          <input value={draft.username ?? ""} onChange={(e) => setDraft({ ...draft, username: e.target.value })} placeholder="用户名（可选）" />
          <input type="password" value={draft.password ?? ""} onChange={(e) => setDraft({ ...draft, password: e.target.value })} placeholder="密码/应用令牌（可选）" />
          <button type="button" onClick={() => void saveConfig()}>保存</button>
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
                  <button type="button" onClick={() => void readFile(e)} title="读取">👁</button>
                )}
                <button type="button" onClick={() => void deleteEntry(e)} title="删除" className="danger">🗑</button>
              </div>
            </li>
          ))}
        </ul>
      ) : selectedProvider && !loading ? (
        <div className="storage-panel__empty">空目录</div>
      ) : null}
      {preview && (
        <div className="storage-panel__preview">
          <div><strong>{preview.name}</strong><button type="button" onClick={() => setPreview(null)}>关闭</button></div>
          <pre>{preview.content}</pre>
        </div>
      )}
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${bytes}B`;
}
