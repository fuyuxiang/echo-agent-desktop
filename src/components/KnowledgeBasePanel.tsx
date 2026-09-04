/**
 * 知识库面板 —— 对齐 EchoAgent `knowledge-base-panel`(可插拔知识源)。
 *
 * EchoAgent 的知识源 provider-agnostic(本地文件夹/网盘/文档库均可注册,见
 * lib/knowledge-base)。本面板提供搜索框 + 跨源结果列表。无 provider 时显示空态。
 */
import { useEffect, useState } from "react";
import {
  searchKbWithDiagnostics,
  listKbProvidersWithStats,
  rebuildAllKbProviders,
  type KbEntry,
  type KbIndexStats,
} from "@/lib/knowledge-base";
import { isTauriAvailable } from "@/lib/tauri-kb-reader";
import { addLocalKnowledgeSource, hydrateKnowledgeSources, removeKnowledgeSource } from "@/lib/kb-source-storage";
import { filesystemPickDirectory } from "@/lib/agent-client";

interface KnowledgeBasePanelProps {
  /** 打开条目回调(可选)。 */
  onOpen?: (entryId: string, url?: string) => void;
  /** 临时反馈(可选)。 */
  onToast?: (msg: string) => void;
}

export function KnowledgeBasePanel({ onOpen, onToast }: KnowledgeBasePanelProps) {
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [results, setResults] = useState<KbEntry[]>([]);
  const [searching, setSearching] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [sources, setSources] = useState<Array<{ id: string; label: string; stats: KbIndexStats }>>([]);
  const [sourcesError, setSourcesError] = useState<string | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchRetryKey, setSearchRetryKey] = useState(0);
  const q = debouncedQuery.trim();
  useEffect(() => {
    let cancelled = false;
    void hydrateKnowledgeSources()
      .then(() => { if (!cancelled) setRefreshKey((key) => key + 1); })
      .catch((error) => onToast?.(`读取知识源失败：${String(error).replace(/^Error:\s*/, "")}`));
    return () => { cancelled = true; };
  }, [onToast]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query), 300);
    return () => window.clearTimeout(timer);
  }, [query]);
  // 每当 refreshKey 变化(添加/移除/重建/搜索)重新拉取含索引状态的源列表。
  useEffect(() => {
    let cancelled = false;
    void listKbProvidersWithStats()
      .then((s) => {
        if (!cancelled) {
          setSources(s);
          setSourcesError(null);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          const message = String(error).replace(/^Error:\s*/, "");
          setSourcesError(message);
          onToast?.(`读取知识源失败：${message}`);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey, onToast]);

  /** 添加本地文件夹知识源:弹出原生目录选择 → 注册 local KbProvider。 */
  const addLocalFolder = async () => {
    if (!isTauriAvailable()) {
      onToast?.("添加知识源需要桌面环境(Tauri)");
      return;
    }
    try {
      const dir = await filesystemPickDirectory();
      if (!dir) return;
      const { added } = await addLocalKnowledgeSource(dir);
      setRefreshKey((k) => k + 1);
      onToast?.(added ? "已添加本地知识源" : "该知识源已存在");
    } catch (e) {
      onToast?.(`添加失败：${String(e).replace(/^Error:\s*/, "")}`);
    }
  };

  /** 移除一个已注册知识源(by id)。 */
  const removeSource = async (id: string) => {
    try {
      if (await removeKnowledgeSource(id)) {
        setRefreshKey((k) => k + 1);
        onToast?.("已移除知识源");
      }
    } catch (error) {
      onToast?.(`移除失败：${String(error).replace(/^Error:\s*/, "")}`);
    }
  };

  /** 重建索引:刷新所有知识源缓存(本地文件夹内容变化后手动重新扫描)。 */
  const [rebuilding, setRebuilding] = useState(false);
  const rebuildIndex = async () => {
    setRebuilding(true);
    try {
      const res = await rebuildAllKbProviders();
      setRefreshKey((k) => k + 1);
      const total = res.reduce((s, r) => s + (r.count ?? 0), 0);
      onToast?.(res.length > 0 ? `已重建索引(${total} 项)` : "无可重建的知识源");
    } catch (e) {
      onToast?.(`重建失败：${String(e).replace(/^Error:\s*/, "")}`);
    } finally {
      setRebuilding(false);
    }
  };

  useEffect(() => {
    if (!q) {
      setResults([]);
      setSearchError(null);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    setSearchError(null);
    void searchKbWithDiagnostics(q)
      .then(({ entries, failures, successfulProviders }) => {
        if (!cancelled) {
          setResults(entries);
          if (failures.length === 0) {
            setSearchError(null);
          } else {
            const details = failures
              .map((failure) => `${failure.label}：${failure.message}`)
              .join("；");
            setSearchError(
              successfulProviders > 0
                ? entries.length > 0
                  ? `部分知识源搜索失败（${details}），已显示其他知识源的结果。`
                  : `部分知识源搜索失败（${details}），其他知识源未找到匹配结果。`
                : `所有知识源搜索失败（${details}）。`,
            );
          }
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setResults([]);
          setSearchError(String(error).replace(/^Error:\s*/, ""));
        }
      })
      .finally(() => {
        if (!cancelled) setSearching(false);
      });
    return () => {
      cancelled = true;
    };
  }, [q, searchRetryKey]);

  return (
    <div className="kb-panel" role="region" aria-label="知识库">
      <div className="kb-panel__head">
        <span className="kb-panel__title">知识库</span>
        <div className="kb-panel__head-right">
          <span className="kb-panel__sources">
            {sources.length > 0 ? `${sources.length} 个源` : "未配置知识源"}
          </span>
          <button
            type="button"
            className="kb-panel__add-btn"
            onClick={() => void addLocalFolder()}
            title="添加本地文件夹作为知识源"
          >
            + 添加本地文件夹
          </button>
          {sources.length > 0 && (
            <button
              type="button"
              className="kb-panel__refresh-btn"
              onClick={() => void rebuildIndex()}
              disabled={rebuilding}
              title="重新扫描所有知识源(文件夹内容变化后刷新)"
            >
              {rebuilding ? "重建中…" : "↻ 刷新索引"}
            </button>
          )}
        </div>
      </div>
      {sourcesError && (
        <div className="kb-panel__index-status" role="alert">
          <span>知识源读取失败：{sourcesError}</span>
          <button type="button" className="kb-panel__refresh-btn" onClick={() => setRefreshKey((key) => key + 1)}>
            重试
          </button>
        </div>
      )}
      {/* 已注册知识源 chip 列表(每个可移除)。 */}
      {sources.length > 0 && (
        <div className="kb-panel__sources-row">
          {sources.map((s) => (
            <span key={s.id} className="kb-panel__source-chip" title={s.label}>
              <span className="kb-panel__source-chip-label">{s.label}</span>
              <button
                type="button"
                className="kb-panel__source-chip-remove"
                onClick={() => void removeSource(s.id)}
                aria-label={`移除知识源 ${s.label}`}
                title="移除此知识源"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      {/* 索引状态指示:已索引文件数 + 最近重建时间(让用户直观感知覆盖范围)。 */}
      {sources.length > 0 && (
        <div className="kb-panel__index-status" aria-live="polite">
          <span className="kb-panel__index-count">
            已索引 {sources.reduce((sum, s) => sum + (s.stats.fileCount ?? 0), 0)} 个文件
          </span>
          {(() => {
            const ts = sources
              .map((s) => s.stats.lastRebuiltAt)
              .filter((t): t is number => typeof t === "number")
              .sort((a, b) => b - a)[0];
            return ts ? (
              <span className="kb-panel__index-time">最近更新 {formatRelativeTime(ts)}</span>
            ) : null;
          })()}
        </div>
      )}
      <input
        className="kb-panel__input"
        type="text"
        value={query}
        placeholder="搜索知识库…"
        onChange={(e) => setQuery(e.target.value)}
        aria-label="搜索知识库"
      />
      {q && (
        <>
          {searchError && !searching && (
            <div className="kb-panel__index-status" role="alert">
              <span>{searchError}</span>
              <button
                type="button"
                className="kb-panel__refresh-btn"
                onClick={() => setSearchRetryKey((key) => key + 1)}
              >
                重试搜索
              </button>
            </div>
          )}
          <ul className="kb-panel__list" aria-label="知识库搜索结果" aria-busy={searching}>
            {searching ? (
              <li className="kb-panel__empty" role="status">搜索中…</li>
            ) : results.length === 0 && !searchError ? (
              <li className="kb-panel__empty">无匹配结果</li>
            ) : (
              results.map((e) => (
                <li key={`${e.source}:${e.id}`}>
                  <button
                    type="button"
                    className="kb-panel__row"
                    onClick={() => onOpen?.(e.id, e.url)}
                    title={e.url ?? e.title}
                    aria-label={`打开知识条目：${e.title}`}
                  >
                    <span className="kb-panel__row-source">{e.source}</span>
                    <span className="kb-panel__row-title">{e.title}</span>
                    {e.snippet && <span className="kb-panel__row-snippet">{e.snippet}</span>}
                  </button>
                </li>
              ))
            )}
          </ul>
        </>
      )}
    </div>
  );
}

/** 把时间戳(ms)格式化为相对时间(如「刚刚 / 3 分钟前 / 2 小时前 / 昨天」)。 */
function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return "刚刚";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day === 1) return "昨天";
  if (day < 30) return `${day} 天前`;
  return new Date(ts).toLocaleDateString();
}
