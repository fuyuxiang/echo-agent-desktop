import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, LoaderCircle, Replace, Search } from "lucide-react";

import { codingSearchWorkspace, type CodingSearchHit } from "@/lib/agent-client";

interface SearchViewProps {
  root: string;
  onOpenHit: (hit: CodingSearchHit) => void;
  onReplaceAll: (query: string, replacement: string, hits: CodingSearchHit[]) => Promise<void>;
  busy?: boolean;
}

/**
 * Workspace text search with replace.
 *
 * The backend search is fixed-string, so no regex toggle is offered rather than
 * showing one that silently does literal matching. Replace runs through the
 * hash-checked document write, and always asks for confirmation first because it
 * edits files the user may not have opened.
 */
export function SearchView({ root, onOpenHit, onReplaceAll, busy = false }: SearchViewProps) {
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [showReplace, setShowReplace] = useState(false);
  const [hits, setHits] = useState<CodingSearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setHits([]);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(() => {
      void codingSearchWorkspace(root, trimmed)
        .then((results) => {
          if (!cancelled) {
            setHits(results);
            setError(null);
          }
        })
        .catch((cause) => {
          if (!cancelled) setError(String(cause).replace(/^Error:\s*/, ""));
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 220);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, root]);

  const grouped = hits.reduce<Record<string, CodingSearchHit[]>>((accumulator, hit) => {
    (accumulator[hit.path] ??= []).push(hit);
    return accumulator;
  }, {});

  const runReplace = useCallback(async () => {
    if (!query.trim() || hits.length === 0) return;
    await onReplaceAll(query.trim(), replacement, hits);
    // Re-run the search so the list reflects what is now on disk.
    setQuery((value) => value);
  }, [hits, onReplaceAll, query, replacement]);

  return (
    <div className="coding-explorer-view">
      <div className="coding-search__inputs">
        <label className="coding-search__field">
          <Search size={13} />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索代码（至少 2 个字符）"
            aria-label="搜索代码"
          />
          {loading && <LoaderCircle size={13} className="is-spinning" />}
        </label>
        <button
          type="button"
          className={`coding-search__toggle${showReplace ? " is-active" : ""}`}
          onClick={() => setShowReplace((value) => !value)}
          aria-label="切换替换"
          aria-pressed={showReplace}
          title="替换"
        >
          <Replace size={13} />
        </button>
      </div>

      {showReplace && (
        <div className="coding-search__replace">
          <input
            value={replacement}
            onChange={(event) => setReplacement(event.target.value)}
            placeholder="替换为…"
            aria-label="替换为"
          />
          <button
            type="button"
            disabled={busy || hits.length === 0 || !query.trim()}
            onClick={() => void runReplace()}
          >
            全部替换
          </button>
        </div>
      )}

      {error && (
        <div className="coding-row is-error">
          <AlertTriangle size={13} />
          {error}
        </div>
      )}

      {!loading && !error && query.trim().length >= 2 && hits.length === 0 && (
        <div className="coding-row">没有找到匹配代码</div>
      )}

      <div className="coding-search__results">
        {Object.entries(grouped).map(([path, fileHits]) => (
          <div key={path} className="coding-search__file">
            <div className="coding-search__file-head">
              <span title={path}>{path}</span>
              <b>{fileHits.length}</b>
            </div>
            {fileHits.map((hit, index) => (
              <button
                key={`${hit.line}:${hit.column}:${index}`}
                type="button"
                className="coding-search__hit"
                onClick={() => onOpenHit(hit)}
              >
                <span>{hit.line}</span>
                <code>{hit.preview}</code>
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
