/**
 * 云存储浏览面板 —— 腾讯 Drive/文档 替代的 UI。
 *
 * 列出已注册的 WebDAV 存储源，并提供浏览、读取、写入与删除操作。
 */
import { useCallback, useEffect, useRef, useState } from "react";
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
import { useAppDialog } from "./AppDialog";

export function CloudStoragePanel({ onToast }: { onToast?: (msg: string) => void }) {
  const [providers, setProviders] = useState<Array<{ id: string; label: string }>>([]);
  const [configs, setConfigs] = useState<StorageProviderConfig[]>([]);
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const [entries, setEntries] = useState<StorageEntry[]>([]);
  const [currentPath, setCurrentPath] = useState("/");
  const [loading, setLoading] = useState(false);
  const [configLoading, setConfigLoading] = useState(true);
  const [configError, setConfigError] = useState<string | null>(null);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [showConfig, setShowConfig] = useState(false);
  const [preview, setPreview] = useState<{ name: string; path: string; content: string } | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [configSaving, setConfigSaving] = useState(false);
  const { requestConfirmation, requestInput, dialog } = useAppDialog(`${selectedProvider ?? ""}\u0000${currentPath}`);
  const configGeneration = useRef(0);
  const browseGeneration = useRef(0);
  const configSavingRef = useRef(false);
  const [draft, setDraft] = useState<StorageProviderConfig>({
    id: "",
    label: "",
    kind: "webdav",
    baseUrl: "",
    username: "",
    password: "",
    enabled: true,
  });

  const loadConfigs = useCallback(async () => {
    const generation = ++configGeneration.current;
    setConfigLoading(true);
    setConfigError(null);
    try {
      const loaded = await hydrateStorageProviders();
      if (configGeneration.current !== generation) return;
      setConfigs(loaded);
      setProviders(listStorageProviders());
    } catch (error) {
      if (configGeneration.current !== generation) return;
      const message = String(error).replace(/^Error:\s*/, "");
      setConfigError(message);
      onToast?.(`读取存储配置失败：${message}`);
    } finally {
      if (configGeneration.current === generation) setConfigLoading(false);
    }
  }, [onToast]);

  useEffect(() => {
    void loadConfigs();
    return () => {
      configGeneration.current += 1;
    };
  }, [loadConfigs]);

  useEffect(() => () => {
    browseGeneration.current += 1;
  }, []);

  const saveConfig = async () => {
    if (configSavingRef.current) return;
    configSavingRef.current = true;
    setConfigSaving(true);
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
    } finally {
      configSavingRef.current = false;
      setConfigSaving(false);
    }
  };

  const removeConfig = () => {
    if (!selectedProvider) return;
    const providerId = selectedProvider;
    const label = providers.find((provider) => provider.id === providerId)?.label ?? providerId;
    requestConfirmation({
      title: `移除存储源“${label}”？`,
      description: "只会移除本机的连接配置，远端文件不会被删除。",
      confirmLabel: "移除配置",
      danger: true,
      action: async () => {
        await removeStorageProviderConfig(providerId);
        unregisterStorageProvider(providerId);
        setConfigs((current) => current.filter((item) => item.id !== providerId));
        setProviders(listStorageProviders());
        setSelectedProvider(null);
        setEntries([]);
        onToast?.("已移除存储源");
      },
      onError: (error) => onToast?.(`移除失败：${String(error).replace(/^Error:\s*/, "")}`),
    });
  };

  const browse = async (providerId: string, path: string) => {
    const provider = getStorageProvider(providerId);
    if (!provider) return;
    const generation = ++browseGeneration.current;
    setLoading(true);
    setBrowseError(null);
    try {
      const list = await provider.list(normalizePath(path));
      if (browseGeneration.current !== generation) return;
      setEntries(list.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1)));
      setCurrentPath(normalizePath(path));
    } catch (e) {
      if (browseGeneration.current !== generation) return;
      const message = String(e).replace(/^Error:\s*/, "");
      setBrowseError(message);
      onToast?.(`浏览失败：${message}`);
    } finally {
      if (browseGeneration.current === generation) setLoading(false);
    }
  };

  const selectProvider = (id: string) => {
    setSelectedProvider(id);
    setEntries([]);
    setCurrentPath("/");
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

  const deleteEntry = (entry: StorageEntry) => {
    if (!selectedProvider) return;
    const providerId = selectedProvider;
    const provider = getStorageProvider(providerId);
    if (!provider) return;
    const path = currentPath;
    requestConfirmation({
      title: `删除${entry.isDir ? "文件夹" : "文件"}“${entry.name}”？`,
      description: "此操作会修改远端存储，且可能无法撤销。",
      confirmLabel: "从远端删除",
      danger: true,
      action: async () => {
        const ok = await provider.delete(entry.path);
        if (!ok) throw new Error("服务端拒绝删除");
        await browse(providerId, path);
        onToast?.(`已删除 ${entry.name}`);
      },
      onError: (error) => onToast?.(`删除失败：${String(error).replace(/^Error:\s*/, "")}`),
    });
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
      const providerId = selectedProvider;
      const path = currentPath;
      const performUpload = async () => {
        setBusyAction("上传中…");
        try {
          for (const localPath of paths) {
            await provider.uploadFile!(joinStoragePath(path, localBasename(localPath)), localPath);
          }
          await browse(providerId, path);
          onToast?.(`已上传 ${paths.length} 个文件`);
        } finally {
          setBusyAction(null);
        }
      };
      if (conflicts > 0) {
        requestConfirmation({
          title: `覆盖 ${conflicts} 个同名文件？`,
          description: "远端的同名文件将被本地文件替换，此操作可能无法撤销。",
          confirmLabel: "覆盖并上传",
          danger: true,
          action: performUpload,
          onError: (error) => onToast?.(`上传失败：${String(error).replace(/^Error:\s*/, "")}`),
        });
        return;
      }
      await performUpload();
    } catch (error) {
      onToast?.(`上传失败：${String(error).replace(/^Error:\s*/, "")}`);
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

  const createFolder = () => {
    if (!selectedProvider) return;
    const providerId = selectedProvider;
    const path = currentPath;
    requestInput({
      title: "新建文件夹",
      description: `将在 ${path} 中创建。`,
      confirmLabel: "创建",
      fields: [{ name: "name", label: "文件夹名称", required: true, maxLength: 255 }],
      validate: (values) => validateStorageName(values.name),
      action: async (values) => {
        const name = values.name.trim();
        const ok = await getStorageProvider(providerId)?.makeDir(joinStoragePath(path, name));
        if (!ok) throw new Error("服务端未创建文件夹");
        await browse(providerId, path);
        onToast?.("文件夹已创建");
      },
      onError: (error) => onToast?.(`创建失败：${String(error).replace(/^Error:\s*/, "")}`),
    });
  };

  const createTextFile = () => {
    if (!selectedProvider) return;
    const providerId = selectedProvider;
    const path = currentPath;
    requestInput({
      title: "新建文本文件",
      description: `将在 ${path} 中创建。文件名和内容可以一次填写。`,
      confirmLabel: "创建文件",
      fields: [
        { name: "name", label: "文件名", defaultValue: "note.md", required: true, maxLength: 255 },
        { name: "content", label: "文件内容", multiline: true, rows: 8, maxLength: 1024 * 1024 },
      ],
      validate: (values) => validateStorageName(values.name),
      action: async (values) => {
        const name = values.name.trim();
        const ok = await getStorageProvider(providerId)?.writeText(joinStoragePath(path, name), values.content);
        if (!ok) throw new Error("服务端未写入文件");
        await browse(providerId, path);
        onToast?.("文件已写入");
      },
      onError: (error) => onToast?.(`写入失败：${String(error).replace(/^Error:\s*/, "")}`),
    });
  };

  return (
    <div className="storage-panel" role="region" aria-label="云存储">
      <div className="storage-panel__head">
        <span className="storage-panel__title">云存储</span>
        {providers.length > 0 ? (
          <select aria-label="选择云存储源" value={selectedProvider ?? ""} onChange={(e) => selectProvider(e.target.value)}>
            <option value="">选择存储源…</option>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </select>
        ) : (
          <span className="storage-panel__muted">
            {configLoading ? "正在读取存储配置…" : configError ? "存储配置暂不可用" : "未配置存储源"}
          </span>
        )}
        <div className="storage-panel__head-actions">
          <button type="button" onClick={beginNewConfig}>+ WebDAV</button>
          {selectedProvider && <button type="button" onClick={editSelectedConfig}>编辑配置</button>}
          {selectedProvider && <button type="button" className="danger" onClick={() => void removeConfig()}>移除配置</button>}
        </div>
      </div>

      {configError && (
        <div className="panel-inline-error" role="alert">
          <span>读取存储配置失败：{configError}</span>
          <button type="button" onClick={() => void loadConfigs()} disabled={configLoading}>
            {configLoading ? "重试中…" : "重试"}
          </button>
        </div>
      )}

      {showConfig && (
        <div className="storage-panel__config">
          <strong>{draft.id ? "编辑 WebDAV" : "添加 WebDAV"}</strong>
          <input aria-label="存储源显示名" value={draft.label} disabled={configSaving} onChange={(e) => setDraft({ ...draft, label: e.target.value })} placeholder="显示名" />
          <input aria-label="WebDAV 地址" value={draft.baseUrl} disabled={configSaving} onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })} placeholder="https://dav.example.com/path" />
          <input aria-label="WebDAV 用户名" value={draft.username ?? ""} disabled={configSaving} onChange={(e) => setDraft({ ...draft, username: e.target.value })} placeholder="用户名（可选）" />
          <input aria-label="WebDAV 密码或应用令牌" type="password" value={draft.password ?? ""} disabled={configSaving} onChange={(e) => setDraft({ ...draft, password: e.target.value })} placeholder="密码/应用令牌（可选）" />
          <label className="storage-panel__enabled"><input type="checkbox" checked={draft.enabled} disabled={configSaving} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} /> 启用此存储源</label>
          <div className="storage-panel__config-actions">
            <button type="button" onClick={() => setShowConfig(false)} disabled={configSaving}>取消</button>
            <button type="button" onClick={() => void saveConfig()} disabled={configSaving || !draft.baseUrl.trim()}>
              {configSaving ? "保存中…" : "保存"}
            </button>
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

      {browseError && selectedProvider && (
        <div className="panel-inline-error" role="alert">
          <span>目录加载失败：{browseError}</span>
          <button type="button" onClick={() => void browse(selectedProvider, currentPath)} disabled={loading}>
            {loading ? "重试中…" : "重试"}
          </button>
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
              {e.isDir ? (
                <button
                  type="button"
                  className="storage-panel__entry-name storage-panel__entry-name--button"
                  onClick={() => openEntry(e)}
                  title="打开目录"
                >
                  {e.name}
                </button>
              ) : (
                <span className="storage-panel__entry-name">{e.name}</span>
              )}
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
      ) : selectedProvider && !loading && !browseError ? (
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
      {dialog}
    </div>
  );
}

function localBasename(path: string): string {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "upload";
}

function validateStorageName(value: string): string | null {
  const name = value.trim();
  if (!name) return "名称不能为空。";
  if (name === "." || name === ".." || /[\\/\u0000-\u001f\u007f]/.test(name)) {
    return "名称不能是 . 或 ..，也不能包含路径分隔符或控制字符。";
  }
  return null;
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${bytes}B`;
}
