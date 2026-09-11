import { Hash, Info } from "lucide-react";

import type { PaletteSymbol } from "../shell/CommandPalette";

interface SymbolViewProps {
  symbols: PaletteSymbol[];
  activeFileName?: string;
  onOpenSymbol: (symbol: PaletteSymbol) => void;
}

/**
 * Symbols of the file currently open in the editor.
 *
 * This is deliberately scoped to one file: cross-file symbol search needs a real
 * index (tree-sitter or LSP), which is not part of this phase. The limitation is
 * stated in the panel rather than implied by an empty list.
 */
export function SymbolView({ symbols, activeFileName, onOpenSymbol }: SymbolViewProps) {
  if (!activeFileName) {
    return (
      <div className="coding-explorer-view coding-explorer-view--empty">
        <Hash size={22} />
        <p>打开一个文件后，这里会列出它的符号。</p>
      </div>
    );
  }

  return (
    <div className="coding-explorer-view">
      <div className="coding-explorer__note">
        <Info size={12} />
        当前仅列出 {activeFileName} 的符号；跨文件符号索引与引用查找将在后续版本接入。
      </div>
      {symbols.length === 0 ? (
        <div className="coding-row">未从当前文件解析到符号</div>
      ) : (
        <div className="coding-symbols">
          {symbols.map((symbol, index) => (
            <button
              key={`${symbol.name}:${symbol.line}:${index}`}
              type="button"
              onClick={() => onOpenSymbol(symbol)}
            >
              <Hash size={11} />
              <span>{symbol.name}</span>
              {symbol.detail && <small>{symbol.detail}</small>}
              <b>{symbol.line}</b>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
