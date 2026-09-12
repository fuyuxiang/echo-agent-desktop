/**
 * Phase 2: virtual tab that renders the impact graph for a symbol.
 *
 * Calls `coding_impact_analyze` and renders the three layers the UI
 * promised: direct callers, transitive callers, and tests that touch
 * the call chain. Clicking any symbol in the list opens it in the editor
 * the same way the symbol view does.
 */

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ChevronRight, FlaskConical, Layers } from "lucide-react";

import { codingApi } from "../lib/tauri-api";
import type { ImpactEdge, ImpactGraph, ImpactNode } from "../lib/types";

interface ImpactAnalysisViewProps {
  root: string;
  symbol: string;
  onOpenSymbol: (symbol: { path: string; line: number; name: string }) => void;
}

export function ImpactAnalysisView({ root, symbol, onOpenSymbol }: ImpactAnalysisViewProps) {
  const [graph, setGraph] = useState<ImpactGraph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    codingApi
      .impactAnalyze(root, symbol, 2, true)
      .then((result) => {
        if (!cancelled) setGraph(result);
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

  const directByFile = useMemo(() => groupByFile(graph?.direct ?? []), [graph]);
  const transitiveByFile = useMemo(() => groupByFile(graph?.transitive ?? []), [graph]);

  if (loading) {
    return <div className="coding-views__empty">正在分析 `{symbol}` 的影响范围…</div>;
  }
  if (error) {
    return <div className="coding-views__error">影响分析失败：{error}</div>;
  }
  if (!graph) {
    return <div className="coding-views__empty">暂无影响范围数据</div>;
  }

  return (
    <div className="coding-impact">
      <header className="coding-impact__header">
        <Layers size={16} />
        <strong>{symbol}</strong>
        <span>深度 {graph.depthUsed} · {graph.direct.length} 直接 · {graph.transitive.length} 传递</span>
      </header>

      <Section title="直接调用方" entries={directByFile} onOpenSymbol={onOpenSymbol} />
      <Section title="传递调用方" entries={transitiveByFile} onOpenSymbol={onOpenSymbol} />

      {graph.testImpact.length > 0 && (
        <section className="coding-impact__group">
          <h3>
            <FlaskConical size={12} />
            受影响测试
          </h3>
          {graph.testImpact.map((symbol, index) => (
            <button
              key={`${symbol.id}:${index}`}
              type="button"
              className="coding-impact__row"
              onClick={() =>
                onOpenSymbol({ path: symbol.file, line: symbol.line, name: symbol.name })
              }
            >
              <AlertTriangle size={12} />
              <span>{symbol.name}</span>
              <small>{symbol.file}</small>
              <b>L{symbol.line}</b>
            </button>
          ))}
        </section>
      )}

      <Edges edges={graph.edges} />
    </div>
  );
}

function Section({
  title,
  entries,
  onOpenSymbol,
}: {
  title: string;
  entries: Array<{ file: string; nodes: ImpactNode[] }>;
  onOpenSymbol: ImpactAnalysisViewProps["onOpenSymbol"];
}) {
  if (entries.length === 0) return null;
  return (
    <>
      {entries.map(({ file, nodes }) => (
        <section key={file} className="coding-impact__group">
          <h3>
            <ChevronRight size={12} />
            {title} · {file}
          </h3>
          {nodes.map((node, index) => (
            <button
              key={`${node.symbol.id}:${index}`}
              type="button"
              className="coding-impact__row"
              onClick={() =>
                onOpenSymbol({
                  path: node.symbol.file,
                  line: node.symbol.line,
                  name: node.symbol.name,
                })
              }
            >
              <span>{node.symbol.name}</span>
              <small>L{node.symbol.line}</small>
              <b>{node.references} 处</b>
              {node.tests > 0 && <span className="coding-impact__tests">{node.tests} 测试</span>}
            </button>
          ))}
        </section>
      ))}
    </>
  );
}

function Edges({ edges }: { edges: ImpactEdge[] }) {
  if (edges.length === 0) return null;
  return (
    <section className="coding-impact__edges">
      <h3>直接引用边</h3>
      <ol>
        {edges.map((edge, index) => (
          <li key={`${edge.fromFile}:${edge.fromLine}:${index}`}>
            <code>
              {edge.fromFile}:{edge.fromLine}
            </code>
            <ChevronRight size={10} />
            <code>{edge.to}</code>
            <small>{edge.kind}</small>
          </li>
        ))}
      </ol>
    </section>
  );
}

function groupByFile(nodes: ImpactNode[]): Array<{ file: string; nodes: ImpactNode[] }> {
  const buckets = new Map<string, ImpactNode[]>();
  for (const node of nodes) {
    const list = buckets.get(node.symbol.file);
    if (list) list.push(node);
    else buckets.set(node.symbol.file, [node]);
  }
  return Array.from(buckets.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([file, nodes]) => ({ file, nodes }));
}

function formatError(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === "string") return reason;
  return JSON.stringify(reason);
}
