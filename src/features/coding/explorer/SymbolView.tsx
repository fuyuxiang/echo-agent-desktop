import { useEffect, useMemo, useState } from "react";
import { Hash, Info } from "lucide-react";

import type { PaletteSymbol } from "../shell/CommandPalette";
import { getSymbolIndexClient } from "../lib/symbol-index";
import type { IndexStatus, SymbolKind, SymbolRecord } from "../lib/types";

interface SymbolViewProps {
  /** Symbols of the currently open file (provided by Monaco). */
  symbols: PaletteSymbol[];
  /** Active file (relative path) — drives the "current file" overlay. */
  activeFileName?: string;
  /** Current workspace root, used for the cross-file index lookup. */
  root?: string;
  /** Called when the user activates any symbol, regardless of source. */
  onOpenSymbol: (symbol: PaletteSymbol) => void;
}

const KIND_LABELS: Record<SymbolKind, string> = {
  function: "函数",
  class: "类",
  method: "方法",
  constant: "常量",
  type: "类型",
  interface: "接口",
  enum: "枚举",
  module: "模块",
  variable: "变量",
};

const VISIBLE_KINDS: SymbolKind[] = ["function", "class", "type", "method", "constant"];

/**
 * Workspace symbol view (phase 2).
 *
 * Default mode: list every parsed symbol in the workspace, grouped by kind,
 * filtered by a substring query. When the editor has a file open, prepend
 * a "current file" section sorted by line number. If the cross-file index
 * has not finished building yet, fall back to the single-file symbols
 * passed via props and surface the status label.
 */
export function SymbolView({
  symbols,
  activeFileName,
  root,
  onOpenSymbol,
}: SymbolViewProps) {
  const [status, setStatus] = useState<IndexStatus | null>(null);
  const [workspaceSymbols, setWorkspaceSymbols] = useState<SymbolRecord[]>([]);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!root) return;
    const client = getSymbolIndexClient(root);
    const unsubscribe = client.subscribe(() => {
      setStatus(client.status_snapshot());
      setWorkspaceSymbols(client.symbols());
    });
    return unsubscribe;
  }, [root]);

  const filteredWorkspace = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return workspaceSymbols;
    return workspaceSymbols.filter((symbol) => symbol.name.toLowerCase().includes(needle));
  }, [query, workspaceSymbols]);

  const grouped = useMemo(() => groupByKind(filteredWorkspace), [filteredWorkspace]);

  const currentFileSymbols = useMemo(
    () => (activeFileName ? filterCurrentFile(filteredWorkspace, activeFileName) : []),
    [activeFileName, filteredWorkspace],
  );

  const statusLabel = formatStatus(status);
  const indexReady = status?.state === "ready" || status?.state === "stale";

  return (
    <div className="coding-explorer-view">
      <div className="coding-explorer__note">
        <Info size={12} />
        {statusLabel}
      </div>

      <div className="coding-symbols__filter">
        <input
          type="search"
          placeholder="跨工作区搜索符号（函数 / 类 / 常量）"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      {indexReady ? (
        <>
          {activeFileName && currentFileSymbols.length > 0 && (
            <SymbolSection
              title={`当前文件 · ${activeFileName}`}
              symbols={currentFileSymbols}
              onOpenSymbol={onOpenSymbol}
            />
          )}
          {grouped.length === 0 ? (
            <div className="coding-row">未在工作区索引中找到匹配的符号</div>
          ) : (
            grouped.map(({ kind, entries }) => (
              <SymbolSection
                key={kind}
                title={KIND_LABELS[kind]}
                symbols={entries}
                onOpenSymbol={onOpenSymbol}
              />
            ))
          )}
        </>
      ) : (
        <SingleFileFallback
          symbols={symbols}
          activeFileName={activeFileName}
          onOpenSymbol={onOpenSymbol}
        />
      )}
    </div>
  );
}

function SymbolSection({
  title,
  symbols,
  onOpenSymbol,
}: {
  title: string;
  symbols: SymbolRecord[];
  onOpenSymbol: (symbol: PaletteSymbol) => void;
}) {
  return (
    <section className="coding-symbols__section">
      <header>{title}</header>
      <div className="coding-symbols">
        {symbols.map((symbol) => (
          <button
            key={symbol.id}
            type="button"
            onClick={() =>
              onOpenSymbol({
                name: symbol.name,
                detail: symbol.signature ?? KIND_LABELS[symbol.kind],
                path: symbol.file,
                line: symbol.line,
              })
            }
          >
            <Hash size={11} />
            <span>{symbol.name}</span>
            <small>{shortenPath(symbol.file)}</small>
            <b>{symbol.line}</b>
          </button>
        ))}
      </div>
    </section>
  );
}

function SingleFileFallback({
  symbols,
  activeFileName,
  onOpenSymbol,
}: {
  symbols: PaletteSymbol[];
  activeFileName?: string;
  onOpenSymbol: (symbol: PaletteSymbol) => void;
}) {
  if (!activeFileName) {
    return (
      <div className="coding-explorer-view coding-explorer-view--empty">
        <Hash size={22} />
        <p>正在构建工作区索引…打开文件后这里会列出它的符号。</p>
      </div>
    );
  }
  if (symbols.length === 0) {
    return <div className="coding-row">未从当前文件解析到符号</div>;
  }
  return (
    <div className="coding-symbols">
      {symbols.map((symbol, index) => (
        <button
          key={`${symbol.name}:${symbol.line}:${index}`}
          type="button"
          title="跨文件索引尚未就绪，仅显示当前文件符号"
          onClick={() => onOpenSymbol(symbol)}
        >
          <Hash size={11} />
          <span>{symbol.name}</span>
          {symbol.detail && <small>{symbol.detail}</small>}
          <b>{symbol.line}</b>
        </button>
      ))}
    </div>
  );
}

function formatStatus(status: IndexStatus | null): string {
  if (!status) return "工作区索引状态未知";
  switch (status.state) {
    case "empty":
      return "工作区索引尚未初始化";
    case "building":
      return `正在构建工作区索引…已扫描 ${status.filesIndexed} 个文件`;
    case "ready":
      return `已就绪 · ${status.symbols} 个符号 / ${status.filesIndexed} 个文件`;
    case "rebuilding":
      return "正在重建工作区索引…";
    case "stale":
      return `索引已过期 · ${status.symbols} 个符号，建议重建`;
  }
}

function groupByKind(symbols: SymbolRecord[]): Array<{ kind: SymbolKind; entries: SymbolRecord[] }> {
  const buckets = new Map<SymbolKind, SymbolRecord[]>();
  for (const symbol of symbols) {
    if (!VISIBLE_KINDS.includes(symbol.kind)) continue;
    const list = buckets.get(symbol.kind);
    if (list) list.push(symbol);
    else buckets.set(symbol.kind, [symbol]);
  }
  return VISIBLE_KINDS.filter((kind) => buckets.has(kind)).map((kind) => ({
    kind,
    entries: buckets.get(kind)!,
  }));
}

function filterCurrentFile(symbols: SymbolRecord[], file: string): SymbolRecord[] {
  return symbols
    .filter((symbol) => symbol.file === file)
    .sort((a, b) => a.line - b.line);
}

function shortenPath(path: string): string {
  const parts = path.split("/");
  if (parts.length <= 2) return path;
  return `…/${parts.slice(-2).join("/")}`;
}
