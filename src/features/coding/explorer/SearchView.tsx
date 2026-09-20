import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, ChevronDown, LoaderCircle, Replace, Search } from "lucide-react";

import {
  codingSearchWorkspace,
  type CodingSearchHit,
  type CodingSearchOptions,
} from "@/lib/agent-client";

interface SearchViewProps {
  root: string;
  onOpenHit: (hit: CodingSearchHit) => void;
  onReplaceAll: (
    query: string,
    replacement: string,
    hits: CodingSearchHit[],
    options: CodingSearchOptions,
  ) => Promise<void>;
  busy?: boolean;
}

/**
 * Workspace text search with replace.
 *
 * Search and replace share one explicit match contract. Replace runs through
 * hash-checked document writes and asks for confirmation because it may edit
 * files the user has not opened.
 */
export function SearchView({ root, onOpenHit, onReplaceAll, busy = false }: SearchViewProps) {
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [showReplace, setShowReplace] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regex, setRegex] = useState(false);
  const [includeGlob, setIncludeGlob] = useState("");
  const [excludeGlob, setExcludeGlob] = useState("");
  const [hits, setHits] = useState<CodingSearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

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
      void codingSearchWorkspace(root, trimmed, {
        caseSensitive,
        wholeWord,
        regex,
        includeGlob: includeGlob.trim(),
        excludeGlob: excludeGlob.trim(),
      })
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
  }, [caseSensitive, excludeGlob, includeGlob, query, regex, revision, root, wholeWord]);

  const grouped = hits.reduce<Record<string, CodingSearchHit[]>>((accumulator, hit) => {
    (accumulator[hit.path] ??= []).push(hit);
    return accumulator;
  }, {});

  const runReplace = useCallback(async () => {
    if (!query.trim() || hits.length === 0) return;
    await onReplaceAll(query.trim(), replacement, hits, {
      caseSensitive,
      wholeWord,
      regex,
      includeGlob: includeGlob.trim(),
      excludeGlob: excludeGlob.trim(),
    });
    // Re-run the search so the list reflects what is now on disk.
    setRevision((value) => value + 1);
  }, [caseSensitive, excludeGlob, hits, includeGlob, onReplaceAll, query, regex, replacement, wholeWord]);

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
        <div className="coding-search__match-options" role="group" aria-label="搜索匹配选项">
          <button type="button" className={caseSensitive ? "is-active" : ""} onClick={() => setCaseSensitive((value) => !value)} aria-pressed={caseSensitive} title="区分大小写">Aa</button>
          <button type="button" className={wholeWord ? "is-active" : ""} onClick={() => setWholeWord((value) => !value)} aria-pressed={wholeWord} title="全字匹配">W</button>
          <button type="button" className={regex ? "is-active" : ""} onClick={() => setRegex((value) => !value)} aria-pressed={regex} title="使用正则表达式">.*</button>
          <button type="button" className={showFilters ? "is-active" : ""} onClick={() => setShowFilters((value) => !value)} aria-expanded={showFilters} title="包含与排除文件"><ChevronDown size={12} /></button>
        </div>
      </div>

      {showFilters && (
        <div className="coding-search__filters">
          <input value={includeGlob} onChange={(event) => setIncludeGlob(event.target.value)} placeholder="包含文件，如 src/**,*.ts" aria-label="包含文件" />
          <input value={excludeGlob} onChange={(event) => setExcludeGlob(event.target.value)} placeholder="排除文件，如 **/*.test.ts" aria-label="排除文件" />
        </div>
      )}

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
