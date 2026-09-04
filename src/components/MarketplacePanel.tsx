/**
 * 市场面板 - 对接 EchoAgent 的 echo.agent/marketplace/list + echo.agent/marketplace/action
 *
 * 显示 EchoAgent 配置的所有插件市场源（marketplace sources）及其插件，
 * 支持安装/卸载/更新/刷新源 + 添加/移除源。
 * 对应 EchoAgent 的 UnifiedMarketPage。
 *
 * 市场源配置在 ~/.echo-agent/config.toml 的 [[marketplace.sources]] 段。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Store,
  RefreshCw,
  PlusCircle,
  Trash2,
  Download,
  Check,
  X,
  Search as SearchIcon,
} from "lucide-react";
import {
  marketplaceAction,
  marketplaceList,
  openUrl,
} from "@/lib/agent-client";
import type { MarketplacePluginEntry, MarketplaceScanResult } from "@/lib/types";
import { useAppDialog } from "./AppDialog";

interface MarketplacePanelProps {
  sessionId?: string;
  onToast?: (msg: string) => void;
}

export function MarketplacePanel({ sessionId, onToast }: MarketplacePanelProps) {
  const [sources, setSources] = useState<MarketplaceScanResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [addingSource, setAddingSource] = useState(false);
  const [newSourceUrl, setNewSourceUrl] = useState("");
  const [externalLinkError, setExternalLinkError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const { requestConfirmation, dialog } = useAppDialog(sessionId);
  const reloadGeneration = useRef(0);

  const reload = useCallback(async () => {
    const generation = ++reloadGeneration.current;
    setLoading(true);
    setLoadError(null);
    try {
      const resp = await marketplaceList(sessionId);
      if (reloadGeneration.current !== generation) return;
      setSources(resp.sources ?? []);
    } catch (e) {
      if (reloadGeneration.current !== generation) return;
      const message = String(e).replace(/^Error:\s*/, "");
      setLoadError(message);
      onToast?.(`加载市场失败：${message}`);
    } finally {
      if (reloadGeneration.current === generation) setLoading(false);
    }
  }, [sessionId, onToast]);

  useEffect(() => {
    void reload();
    return () => {
      reloadGeneration.current += 1;
    };
  }, [reload]);

  const requireSession = (): string | null => {
    if (!sessionId) {
      onToast?.("需要先开启一个会话才能操作市场");
      return null;
    }
    return sessionId;
  };

  const handleInstall = useCallback(
    async (source: MarketplaceScanResult, plugin: MarketplacePluginEntry) => {
      const sid = requireSession();
      if (!sid) return;
      const key = `${source.sourceName}/${plugin.name}`;
      setBusy(key);
      try {
        await marketplaceAction(sid, {
          type: "install",
          sourceUrlOrPath: source.sourceUrlOrPath,
          pluginRelativePath: plugin.relativePath,
        });
        onToast?.(`已安装「${plugin.name}」`);
        reload();
      } catch (e) {
        onToast?.(`安装失败：${String(e).replace(/^Error:\s*/, "")}`);
      } finally {
        setBusy(null);
      }
    },
    [sessionId, onToast, reload],
  );

  const handleUninstall = useCallback(
    (source: MarketplaceScanResult, plugin: MarketplacePluginEntry) => {
      const sid = requireSession();
      if (!sid) return;
      requestConfirmation({
        title: `卸载插件“${plugin.name}”？`,
        description: "将从本机移除该插件。如果之后仍需要，可以从市场重新安装。",
        confirmLabel: "卸载",
        danger: true,
        action: async () => {
          const key = `${source.sourceName}/${plugin.name}`;
          setBusy(key);
          try {
            await marketplaceAction(sid, {
              type: "uninstall",
              sourceUrlOrPath: source.sourceUrlOrPath,
              pluginRelativePath: plugin.relativePath,
            });
            onToast?.(`已卸载「${plugin.name}」`);
            await reload();
          } finally {
            setBusy(null);
          }
        },
        onError: (error) => onToast?.(`卸载失败：${String(error).replace(/^Error:\s*/, "")}`),
      });
    },
    [sessionId, onToast, reload, requestConfirmation],
  );

  const handleUpdate = useCallback(
    async (source: MarketplaceScanResult, plugin: MarketplacePluginEntry) => {
      const sid = requireSession();
      if (!sid) return;
      const key = `${source.sourceName}/${plugin.name}`;
      setBusy(key);
      try {
        await marketplaceAction(sid, {
          type: "update",
          sourceUrlOrPath: source.sourceUrlOrPath,
          pluginRelativePath: plugin.relativePath,
        });
        onToast?.(`已更新「${plugin.name}」`);
        reload();
      } catch (e) {
        onToast?.(`更新失败：${String(e).replace(/^Error:\s*/, "")}`);
      } finally {
        setBusy(null);
      }
    },
    [sessionId, onToast, reload],
  );

  const handleRefreshSource = useCallback(
    async (source?: MarketplaceScanResult) => {
      const sid = requireSession();
      if (!sid) return;
      setBusy(`refresh:${source?.sourceName ?? "all"}`);
      try {
        await marketplaceAction(sid, {
          type: "refresh",
          sourceUrlOrPath: source?.sourceUrlOrPath ?? null,
        });
        onToast?.(source ? `已刷新「${source.sourceName}」` : "已刷新所有源");
        reload();
      } catch (e) {
        onToast?.(`刷新失败：${String(e).replace(/^Error:\s*/, "")}`);
      } finally {
        setBusy(null);
      }
    },
    [sessionId, onToast, reload],
  );

  const handleRemoveSource = useCallback(
    (source: MarketplaceScanResult) => {
      const sid = requireSession();
      if (!sid) return;
      requestConfirmation({
        title: `移除市场源“${source.sourceName}”？`,
        description: "市场源配置将从本机移除，已安装的插件不会被删除。",
        confirmLabel: "移除源",
        danger: true,
        action: async () => {
          setBusy(`remove:${source.sourceName}`);
          try {
            await marketplaceAction(sid, {
              type: "remove_source",
              sourceUrlOrPath: source.sourceUrlOrPath,
            });
            onToast?.(`已移除源「${source.sourceName}」`);
            await reload();
          } finally {
            setBusy(null);
          }
        },
        onError: (error) => onToast?.(`移除失败：${String(error).replace(/^Error:\s*/, "")}`),
      });
    },
    [sessionId, onToast, reload, requestConfirmation],
  );

  const handleAddSource = useCallback(async () => {
    const sid = requireSession();
    if (!sid) return;
    const url = newSourceUrl.trim();
    if (!url) return;
    setBusy("add-source");
    try {
      await marketplaceAction(sid, { type: "add_source", url });
      onToast?.(`已添加源 ${url}`);
      setNewSourceUrl("");
      setAddingSource(false);
      reload();
    } catch (e) {
      onToast?.(`添加失败：${String(e).replace(/^Error:\s*/, "")}`);
    } finally {
      setBusy(null);
    }
  }, [sessionId, newSourceUrl, onToast, reload]);

  const handleOpenHomepage = useCallback(async (plugin: MarketplacePluginEntry) => {
    if (!plugin.homepage) return;
    setExternalLinkError(null);
    try {
      await openUrl(plugin.homepage);
    } catch (error) {
      const message = `无法打开「${plugin.name}」主页：${String(error).replace(/^Error:\s*/, "")}`;
      setExternalLinkError(message);
      onToast?.(message);
    }
  }, [onToast]);

  // Flatten all plugins across sources for the search box.
  const allPlugins = sources.flatMap((s) =>
    s.plugins.map((p) => ({ source: s, plugin: p })),
  );
  const filtered = allPlugins.filter(({ plugin }) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return (
      plugin.name.toLowerCase().includes(q) ||
      (plugin.description ?? "").toLowerCase().includes(q) ||
      (plugin.category ?? "").toLowerCase().includes(q) ||
      (plugin.tags ?? []).some((t) => t.toLowerCase().includes(q))
    );
  });

  const totalPlugins = allPlugins.length;
  const installedCount = allPlugins.filter(
    ({ plugin }) => plugin.installStatus === "installed",
  ).length;

  return (
    <div className="marketplace-panel">
      <div className="marketplace-panel__header">
        <h2 className="marketplace-panel__title">市场</h2>
        <div className="marketplace-panel__actions">
          <button
            className="marketplace-panel__action-btn"
            onClick={() => handleRefreshSource()}
            disabled={loading || busy === "refresh:all"}
            title="刷新所有源"
          >
            <RefreshCw size={14} /> 刷新全部
          </button>
          <button
            className="marketplace-panel__action-btn marketplace-panel__action-btn--primary"
            onClick={() => setAddingSource((v) => !v)}
            title="添加市场源（git URL）"
          >
            <PlusCircle size={14} /> 添加源
          </button>
        </div>
      </div>

      {addingSource && (
        <div className="marketplace-panel__add-source">
          <input
            type="text"
            className="marketplace-panel__add-input"
            placeholder="https://github.com/owner/marketplace-repo.git"
            aria-label="市场源 Git URL"
            value={newSourceUrl}
            onChange={(e) => setNewSourceUrl(e.target.value)}
            autoFocus
          />
          <button
            className="marketplace-panel__action-btn marketplace-panel__action-btn--primary"
            onClick={handleAddSource}
            disabled={busy === "add-source" || !newSourceUrl.trim()}
          >
            {busy === "add-source" ? "添加中…" : "添加"}
          </button>
          <button
            type="button"
            className="marketplace-panel__action-btn"
            aria-label="取消添加市场源"
            title="取消"
            onClick={() => {
              setAddingSource(false);
              setNewSourceUrl("");
            }}
          >
            <X size={14} />
          </button>
        </div>
      )}

      <div className="marketplace-panel__search">
        <SearchIcon size={16} className="marketplace-panel__search-icon" />
        <input
          type="text"
          className="marketplace-panel__search-input"
          placeholder="搜索插件…"
          aria-label="搜索市场插件"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div className="marketplace-panel__stats">
        {sources.length} 个源 · {totalPlugins} 个插件 · {installedCount} 已安装
      </div>

      {externalLinkError && (
        <div className="marketplace-source__error" role="alert">
          <span>{externalLinkError}</span>
          <button type="button" onClick={() => setExternalLinkError(null)} aria-label="关闭外链错误">×</button>
        </div>
      )}

      {loadError && (
        <div className="panel-inline-error" role="alert">
          <span>市场数据加载失败：{loadError}</span>
          <button type="button" onClick={() => void reload()} disabled={loading}>
            {loading ? "重试中…" : "重试"}
          </button>
        </div>
      )}

      {!sessionId && (
        <p className="marketplace-panel__hint">
          ⚠ 安装/卸载需要一个活动会话。请先在主页开启对话。
        </p>
      )}

      {sources.length === 0 && !loading && !loadError && (
        <div className="marketplace-panel__empty">
          <Store size={48} color="var(--echo-text-tertiary)" />
          <p>暂无市场源。</p>
          <p className="marketplace-panel__hint">
            点「添加源」输入 git URL，或在 config.toml 配置 <code>[[marketplace.sources]]</code>。
          </p>
        </div>
      )}

      {/* 按源分组展示 */}
      {!query &&
        sources.map((source) => (
          <div key={source.sourceUrlOrPath} className="marketplace-source">
            <div className="marketplace-source__header">
              <div className="marketplace-source__name">{source.sourceName}</div>
              <div className="marketplace-source__meta">
                {source.sourceKind} · {source.plugins.length} 个插件
              </div>
              <div className="marketplace-source__actions">
                <button
                  className="marketplace-source__btn"
                  onClick={() => handleRefreshSource(source)}
                  disabled={busy === `refresh:${source.sourceName}`}
                  title="刷新此源"
                >
                  <RefreshCw size={12} />
                </button>
                <button
                  className="marketplace-source__btn marketplace-source__btn--danger"
                  onClick={() => handleRemoveSource(source)}
                  disabled={busy === `remove:${source.sourceName}`}
                  title="移除源"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            </div>
            {source.error && (
              <div className="marketplace-source__error">{source.error}</div>
            )}
            <div className="marketplace-source__plugins">
              {source.plugins.map((plugin) => (
                <MarketplacePluginCard
                  key={plugin.relativePath}
                  plugin={plugin}
                  busy={busy === `${source.sourceName}/${plugin.name}`}
                  onInstall={() => handleInstall(source, plugin)}
                  onUninstall={() => handleUninstall(source, plugin)}
                  onUpdate={() => handleUpdate(source, plugin)}
                  onOpenHomepage={() => void handleOpenHomepage(plugin)}
                />
              ))}
            </div>
          </div>
        ))}

      {/* 搜索结果（扁平） */}
      {query &&
        filtered.map(({ source, plugin }) => (
          <MarketplacePluginCard
            key={`${source.sourceUrlOrPath}/${plugin.relativePath}`}
            plugin={plugin}
            sourceName={source.sourceName}
            busy={busy === `${source.sourceName}/${plugin.name}`}
            onInstall={() => handleInstall(source, plugin)}
            onUninstall={() => handleUninstall(source, plugin)}
            onUpdate={() => handleUpdate(source, plugin)}
            onOpenHomepage={() => void handleOpenHomepage(plugin)}
          />
        ))}

      {query && filtered.length === 0 && !loading && (
        <div className="marketplace-panel__empty">无匹配的插件</div>
      )}
      {loading && <div className="marketplace-panel__empty">加载中…</div>}
      {dialog}
    </div>
  );
}

function MarketplacePluginCard({
  plugin,
  sourceName,
  busy,
  onInstall,
  onUninstall,
  onUpdate,
  onOpenHomepage,
}: {
  plugin: MarketplacePluginEntry;
  sourceName?: string;
  busy: boolean;
  onInstall: () => void;
  onUninstall: () => void;
  onUpdate: () => void;
  onOpenHomepage: () => void;
}) {
  const installed = plugin.installStatus === "installed";
  return (
    <div className={`mp-plugin ${installed ? "mp-plugin--installed" : ""}`}>
      <div className="mp-plugin__body">
        <div className="mp-plugin__name">
          {plugin.name}
          {plugin.version && (
            <span className="mp-plugin__version">v{plugin.version}</span>
          )}
          {installed && (
            <span className="mp-plugin__badge mp-plugin__badge--installed">
              <Check size={10} /> 已安装
              {plugin.installedVersion && plugin.installedVersion !== plugin.version
                ? ` (v${plugin.installedVersion})`
                : ""}
            </span>
          )}
          {plugin.category && (
            <span className="mp-plugin__badge">{plugin.category}</span>
          )}
        </div>
        {plugin.description && (
          <div className="mp-plugin__desc">{plugin.description}</div>
        )}
        <div className="mp-plugin__meta">
          {sourceName && <span>来源：{sourceName}</span>}
          {plugin.author && <span>作者：{plugin.author}</span>}
          {plugin.skillCount > 0 && <span>{plugin.skillCount} 技能</span>}
          {plugin.hasAgents && <span>含助理</span>}
          {plugin.hasHooks && <span>含 Hooks</span>}
          {plugin.hasMcp && <span>含 MCP</span>}
          {plugin.homepage && (
            <button
              type="button"
              className="mp-plugin__link"
              onClick={onOpenHomepage}
            >
              主页
            </button>
          )}
        </div>
      </div>
      <div className="mp-plugin__actions">
        {busy ? (
          <span className="mp-plugin__busy">处理中…</span>
        ) : installed ? (
          <>
            {plugin.installedVersion &&
              plugin.installedVersion !== plugin.version && (
                <button
                  className="mp-plugin__btn mp-plugin__btn--update"
                  onClick={onUpdate}
                  title={`更新到 v${plugin.version}`}
                >
                  更新
                </button>
              )}
            <button
              className="mp-plugin__btn mp-plugin__btn--danger"
              onClick={onUninstall}
            >
              卸载
            </button>
          </>
        ) : (
          <button
            className="mp-plugin__btn mp-plugin__btn--install"
            onClick={onInstall}
          >
            <Download size={12} /> 安装
          </button>
        )}
      </div>
    </div>
  );
}
