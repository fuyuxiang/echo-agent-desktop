/**
 * Phase 2: virtual tab that renders the references of a single symbol.
 *
 * Pure presentational — the parent (`CodingWorkbench`) wires the
 * `coding_refs_find` Tauri command. We group hits by file so the user can
 * skim "who calls this?" without scanning one flat list. Each row jumps
 * to the file at the hit's line via the same `onOpenSymbol` callback the
 * editor uses for symbol navigation.
 */

import { useEffect, useMemo, useState } from "react";
import { FileText, ListTree } from "lucide-react";

import { codingApi } from "../lib/tauri-api";
import type { ReferenceHit, ReferenceKind, ReferenceRecord } from "../lib/types";

interface FindReferencesViewProps {
  root: string;
  symbol: string;
  onOpenSymbol: (symbol: { path: string; line: number; name: string }) => void;
}

const KIND_LABELS: Record<ReferenceKind, string> = {
  definition: "定义",
  read: "读取",
  write: "写入",
  call: "调用",
  import: "导入",
  type: "类型",
  unknown: "未知",
};

export function FindReferencesView({ root, symbol, onOpenSymbol }: FindReferencesViewProps) {
  const [hits, setHits] = useState<ReferenceHit[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    codingApi
      .refsFind(root, symbol, true)
      .then((result) => {
        if (!cancelled) setHits(result);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(formatError(reason));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [root, symbol]);

  const grouped = useMemo(() => groupByFile(hits), [hits]);

  if (loading) {
    return <div className="coding-views__empty">正在搜索 `{symbol}` 的引用…</div>;
  }
  if (error) {
    return <div className="coding-views__error">引用搜索失败：{error}</div>;
  }
  if (hits.length === 0) {
    return <div className="coding-views__empty">未找到 `{symbol}` 的引用</div>;
  }

  return (
    <div className="coding-find-references">
      <header className="coding-find-references__header">
        <ListTree size={16} />
        <strong>{symbol}</strong>
        <span>{hits.length} 处引用 · {grouped.length} 个文件</span>
      </header>
      <div className="coding-find-references__hint">基于正则近似匹配，结果仅供参考。</div>
      {grouped.map(({ file, entries }) => (
        <section key={file} className="coding-find-references__group">
          <h3>
            <FileText size={12} />
            {file}
          </h3>
          {entries.map((hit, index) => (
            <ReferenceRow
              key={`${hit.reference.file}:${hit.reference.line}:${hit.reference.column}:${index}`}
              hit={hit}
              onOpenSymbol={onOpenSymbol}
            />
          ))}
        </section>
      ))}
    </div>
  );
}

function ReferenceRow({
  hit,
  onOpenSymbol,
}: {
  hit: ReferenceHit;
  onOpenSymbol: FindReferencesViewProps["onOpenSymbol"];
}) {
  return (
    <button
      type="button"
      className="coding-find-references__row"
      onClick={() =>
        onOpenSymbol({
          path: hit.reference.file,
          line: hit.reference.line,
          name: hit.reference.symbol,
        })
      }
    >
      <span className="coding-find-references__kind">{KIND_LABELS[hit.reference.kind]}</span>
      <span className="coding-find-references__line">L{hit.reference.line}</span>
      <code>{hit.reference.preview}</code>
      {hit.enclosingSymbol && (
        <small>在 {hit.enclosingSymbol.name} 内</small>
      )}
    </button>
  );
}

function groupByFile(hits: ReferenceHit[]): Array<{ file: string; entries: ReferenceHit[] }> {
  const buckets = new Map<string, ReferenceHit[]>();
  for (const hit of hits) {
    const list = buckets.get(hit.reference.file);
    if (list) list.push(hit);
    else buckets.set(hit.reference.file, [hit]);
  }
  return Array.from(buckets.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([file, entries]) => ({ file, entries }));
}

function formatError(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === "string") return reason;
  return JSON.stringify(reason);
}

export type { ReferenceRecord };
