import { useCallback, useEffect, useRef, useState } from "react";
import { Search, X, Clock, FileText } from "lucide-react";
import { useSessionsStore } from "@/stores/sessions-store";
import { agentListSessions, sessionSearch } from "@/lib/agent-client";
import type { SearchHit, SessionSummary } from "@/lib/types";

/**
 * Session search overlay — now powered by EchoAgent's FTS5 full-text index.
 *
 * Two modes:
 *  - Empty / short query: filter the current workspace's session list by
 *    title (instant, local).
 *  - Query ≥ 2 chars: fire `echo.agent/session/search` against EchoAgent's full-text
 *    index (cross-workspace, matches message content + titles). Results show
 *    a snippet of the matched content.
 *
 * Selecting an uncached FTS hit hydrates its workspace summary first, so the
 * parent always receives an authoritative cwd/title/model tuple.
 */
export function SearchOverlay({
  open,
  onClose,
  onSelect,
}: {
  open: boolean;
  onClose: () => void;
  onSelect: (sessionId: string, cwd?: string) => void | Promise<void>;
}) {
  // The local catalog already spans every historical working directory.
  const independent = useSessionsStore((s) => s.independent);
  const sessions = independent;
  const [query, setQuery] = useState("");
  const [remoteHits, setRemoteHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchGenerationRef = useRef(0);
  const lifecycleGenerationRef = useRef(0);
  const openingRef = useRef(false);

  useEffect(() => {
    if (open) {
      const lifecycleGeneration = ++lifecycleGenerationRef.current;
      previousFocusRef.current = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
      setQuery("");
      setRemoteHits([]);
      setSearchError(null);
      setOpeningId(null);
      const t = setTimeout(() => inputRef.current?.focus(), 0);
      return () => {
        clearTimeout(t);
        searchGenerationRef.current += 1;
        if (lifecycleGenerationRef.current === lifecycleGeneration) {
          lifecycleGenerationRef.current += 1;
        }
        openingRef.current = false;
        previousFocusRef.current?.focus();
      };
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const focusable = Array.from(
        modalRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Debounced remote search. Only kicks in for queries ≥ 2 chars.
  const runRemoteSearch = useCallback(async (q: string) => {
    const generation = ++searchGenerationRef.current;
    if (q.trim().length < 2) {
      setRemoteHits([]);
      setSearchError(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    setSearchError(null);
    try {
      const hits = await sessionSearch(q.trim(), undefined, 30);
      if (searchGenerationRef.current === generation) setRemoteHits(hits);
    } catch (error) {
      if (searchGenerationRef.current === generation) {
        setRemoteHits([]);
        setSearchError(String(error).replace(/^Error:\s*/, ""));
      }
    } finally {
      if (searchGenerationRef.current === generation) setSearching(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => runRemoteSearch(query), 250);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, open, runRemoteSearch]);

  // Local title matches (always computed, instant).
  const localMatches: SessionSummary[] = (() => {
    const q = query.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter((s) => s.title.toLowerCase().includes(q));
  })();

  // Prefer the FTS result for duplicate ids because it carries the matching
  // message snippet; keep title-only local rows for ids FTS did not return.
  const remoteIds = new Set(remoteHits.map((hit) => hit.sessionId));
  const localOnly = localMatches.filter((session) => !remoteIds.has(session.sessionId));

  const openSession = async (sessionId: string, cwd?: string) => {
    if (openingRef.current) return;
    openingRef.current = true;
    const lifecycleGeneration = lifecycleGenerationRef.current;
    setOpeningId(sessionId);
    setSearchError(null);
    try {
      let summary = sessions.find((item) => item.sessionId === sessionId);
      if (!summary) {
        if (!cwd) throw new Error("检索结果缺少工作目录信息，无法打开");
        const hydrated = await agentListSessions(cwd, true);
        if (lifecycleGenerationRef.current !== lifecycleGeneration) return;
        useSessionsStore.getState().mergeSessions(hydrated);
        summary = hydrated.find((item) => item.sessionId === sessionId);
      }
      if (!summary) {
        throw new Error("会话不存在、已归档，或当前无权访问");
      }
      if (summary.archived) {
        throw new Error("该会话已归档，请先在侧栏的归档筛选中恢复");
      }
      await onSelect(summary.sessionId, summary.cwd);
      if (lifecycleGenerationRef.current === lifecycleGeneration) onClose();
    } catch (error) {
      if (lifecycleGenerationRef.current === lifecycleGeneration) {
        setSearchError(String(error).replace(/^Error:\s*/, ""));
      }
    } finally {
      if (lifecycleGenerationRef.current === lifecycleGeneration) {
        openingRef.current = false;
        setOpeningId(null);
      }
    }
  };

  if (!open) return null;

  return (
    <div
      className="conversation-search-modal__overlay"
      role="dialog"
      aria-modal="true"
      aria-label="搜索会话"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="conversation-search-modal" ref={modalRef}>
        <div className="conversation-search-modal__input-wrapper">
          <Search size={16} strokeWidth={1.75} className="conversation-search-modal__icon" />
          <input
            ref={inputRef}
            className="conversation-search-modal__input"
            placeholder="搜索会话标题或内容…"
            aria-label="搜索会话标题或内容"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {searching && (
            <span className="conversation-search-modal__spinner" role="status" aria-live="polite">搜索中…</span>
          )}
          <button
            className="conversation-search-modal__close"
            onClick={onClose}
            aria-label="关闭"
            type="button"
          >
            <X size={16} strokeWidth={1.75} />
          </button>
        </div>

        <div className="conversation-search-modal__body">
          {searchError && (
            <div className="conversation-search-modal__empty" role="alert">
              <div>搜索或打开失败：{searchError}</div>
              {query.trim().length >= 2 && (
                <button type="button" onClick={() => void runRemoteSearch(query)}>重试搜索</button>
              )}
            </div>
          )}
          {localOnly.length > 0 && (
            <>
              <div className="conversation-search-modal__count">
                本地会话 ({localOnly.length})
              </div>
              <ul className="conversation-search-modal__list">
                {localOnly.slice(0, 30).map((s) => (
                  <li key={s.sessionId}>
                    <button
                      type="button"
                      className="conversation-search-modal__item"
                      onClick={() => void openSession(s.sessionId, s.cwd)}
                      disabled={openingId !== null}
                      title={s.title}
                    >
                      <Clock
                        size={14}
                        strokeWidth={1.75}
                        className="conversation-search-modal__item-icon"
                      />
                      <span className="conversation-search-modal__item-title">
                        {s.title}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}

          {remoteHits.length > 0 && (
            <>
              <div className="conversation-search-modal__count">
                全文检索结果 ({remoteHits.length})
              </div>
              <ul className="conversation-search-modal__list">
                {remoteHits.map((h) => (
                  <li key={h.sessionId}>
                    <button
                      type="button"
                      className="conversation-search-modal__item conversation-search-modal__item--remote"
                      onClick={() => void openSession(h.sessionId, h.cwd)}
                      disabled={openingId !== null}
                      title={h.cwd ?? h.sessionId}
                    >
                      <FileText
                        size={14}
                        strokeWidth={1.75}
                        className="conversation-search-modal__item-icon"
                      />
                      <div className="conversation-search-modal__item-body">
                        <div className="conversation-search-modal__item-title">
                          {h.title || h.sessionId.slice(0, 8)}
                        </div>
                        {h.snippet && (
                          <div className="conversation-search-modal__item-snippet">
                            {h.snippet}
                          </div>
                        )}
                        {h.cwd && (
                          <div className="conversation-search-modal__item-cwd">
                            {h.cwd}
                          </div>
                        )}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}

          {!searching &&
            !searchError &&
            localOnly.length === 0 &&
            remoteHits.length === 0 &&
            query.trim().length > 0 && (
              <div className="conversation-search-modal__empty">
                没有匹配的会话
              </div>
            )}
          {!searching &&
            !searchError &&
            localOnly.length === 0 &&
            remoteHits.length === 0 &&
            query.trim().length === 0 && (
              <div className="conversation-search-modal__count">
                输入关键词搜索会话内容（EchoAgent FTS5 全文索引）
              </div>
            )}
        </div>
      </div>
    </div>
  );
}
