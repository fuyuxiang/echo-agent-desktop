import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CornerDownLeft, FileCode2, Hash, Search, Terminal } from "lucide-react";

import {
  filterCommands,
  filterPaths,
  GROUP_LABELS,
  type WorkbenchCommand,
} from "../lib/commands";

/** Which list the palette is currently searching. */
export type PaletteMode = "commands" | "files" | "symbols";

export interface PaletteSymbol {
  name: string;
  detail?: string;
  path: string;
  line: number;
}

interface CommandPaletteProps {
  mode: PaletteMode;
  commands: WorkbenchCommand[];
  paths: string[];
  symbols: PaletteSymbol[];
  pathsLoading?: boolean;
  onClose: () => void;
  onOpenPath: (path: string) => void;
  onOpenSymbol: (symbol: PaletteSymbol) => void;
  onModeChange: (mode: PaletteMode) => void;
}

const PLACEHOLDERS: Record<PaletteMode, string> = {
  commands: "输入命令名称，或用 > 前缀继续搜索命令",
  files: "按文件名搜索，输入 > 切换到命令",
  symbols: "按符号名称搜索当前文件",
};

const MODE_ICONS: Record<PaletteMode, typeof Terminal> = {
  commands: Terminal,
  files: FileCode2,
  symbols: Hash,
};

/**
 * The palette is where most of the workbench's capability lives. Keeping these
 * actions searchable rather than on screen is what allows the visible UI to stay
 * quiet while the feature set grows.
 *
 * Typing `>` switches to command mode the way VS Code does, so a user who opened
 * quick-open by reflex can still get to commands without reopening.
 */
export function CommandPalette({
  mode,
  commands,
  paths,
  symbols,
  pathsLoading = false,
  onClose,
  onOpenPath,
  onOpenSymbol,
  onModeChange,
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setQuery("");
    setActive(0);
    inputRef.current?.focus();
  }, [mode]);

  // A leading `>` always means "search commands", whichever mode we opened in.
  const effectiveMode: PaletteMode = query.startsWith(">") ? "commands" : mode;
  const effectiveQuery = query.startsWith(">") ? query.slice(1) : query;

  const commandResults = useMemo(
    () => (effectiveMode === "commands" ? filterCommands(commands, effectiveQuery) : []),
    [commands, effectiveMode, effectiveQuery],
  );
  const pathResults = useMemo(
    () => (effectiveMode === "files" ? filterPaths(paths, effectiveQuery) : []),
    [effectiveMode, effectiveQuery, paths],
  );
  const symbolResults = useMemo(() => {
    if (effectiveMode !== "symbols") return [];
    const needle = effectiveQuery.trim().toLowerCase();
    if (!needle) return symbols.slice(0, 50);
    return symbols
      .filter((symbol) => symbol.name.toLowerCase().includes(needle))
      .slice(0, 50);
  }, [effectiveMode, effectiveQuery, symbols]);

  const total =
    effectiveMode === "commands"
      ? commandResults.length
      : effectiveMode === "files"
        ? pathResults.length
        : symbolResults.length;

  useEffect(() => setActive(0), [effectiveQuery, effectiveMode]);

  const commit = useCallback(
    (index: number) => {
      if (effectiveMode === "commands") {
        const command = commandResults[index];
        if (!command || command.enabled === false) return;
        onClose();
        void command.run();
        return;
      }
      if (effectiveMode === "files") {
        const path = pathResults[index];
        if (!path) return;
        onClose();
        onOpenPath(path);
        return;
      }
      const symbol = symbolResults[index];
      if (!symbol) return;
      onClose();
      onOpenSymbol(symbol);
    },
    [commandResults, effectiveMode, onClose, onOpenPath, onOpenSymbol, pathResults, symbolResults],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActive((value) => (total === 0 ? 0 : (value + 1) % total));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActive((value) => (total === 0 ? 0 : (value - 1 + total) % total));
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        commit(active);
      }
    },
    [active, commit, onClose, total],
  );

  // Keep the highlighted row inside the scroll viewport. Guarded because
  // scrollIntoView is absent in some environments (jsdom, older WebViews) and a
  // missing scroll must never break keyboard navigation.
  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    node?.scrollIntoView?.({ block: "nearest" });
  }, [active]);

  const Icon = MODE_ICONS[effectiveMode];

  return (
    <div
      className="coding-palette__scrim"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="coding-palette"
        role="dialog"
        aria-modal="true"
        aria-label="命令面板"
        onKeyDown={onKeyDown}
      >
        <div className="coding-palette__field">
          <Icon size={15} />
          <input
            ref={inputRef}
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={PLACEHOLDERS[effectiveMode]}
            aria-label="命令面板搜索"
            role="combobox"
            aria-expanded="true"
            aria-controls="coding-palette-list"
            aria-activedescendant={total > 0 ? `coding-palette-row-${active}` : undefined}
          />
          <div className="coding-palette__modes" role="tablist" aria-label="面板模式">
            {(["commands", "files", "symbols"] as PaletteMode[]).map((candidate) => (
              <button
                key={candidate}
                type="button"
                role="tab"
                aria-selected={effectiveMode === candidate}
                className={effectiveMode === candidate ? "is-active" : ""}
                onClick={() => onModeChange(candidate)}
              >
                {candidate === "commands" ? "命令" : candidate === "files" ? "文件" : "符号"}
              </button>
            ))}
          </div>
        </div>

        <div className="coding-palette__list" id="coding-palette-list" role="listbox" ref={listRef}>
          {effectiveMode === "commands" &&
            commandResults.map((command, index) => {
              const previous = commandResults[index - 1];
              const showGroup = !previous || previous.group !== command.group;
              return (
                <div key={command.id}>
                  {showGroup && (
                    <div className="coding-palette__group">{GROUP_LABELS[command.group]}</div>
                  )}
                  <button
                    type="button"
                    id={`coding-palette-row-${index}`}
                    role="option"
                    aria-selected={index === active}
                    aria-disabled={command.enabled === false}
                    data-active={index === active}
                    className={`coding-palette__row${command.enabled === false ? " is-disabled" : ""}`}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => commit(index)}
                  >
                    <span>{command.title}</span>
                    {command.hint && <small>{command.hint}</small>}
                    {index === active && command.enabled !== false && <CornerDownLeft size={12} />}
                  </button>
                </div>
              );
            })}

          {effectiveMode === "files" && (
            <>
              {pathsLoading && pathResults.length === 0 && (
                <div className="coding-palette__empty">
                  <Search size={15} />
                  正在建立文件索引…
                </div>
              )}
              {pathResults.map((path, index) => (
                <button
                  key={path}
                  type="button"
                  id={`coding-palette-row-${index}`}
                  role="option"
                  aria-selected={index === active}
                  data-active={index === active}
                  className="coding-palette__row"
                  onMouseEnter={() => setActive(index)}
                  onClick={() => commit(index)}
                >
                  <span>{path.slice(path.lastIndexOf("/") + 1)}</span>
                  <small>{path}</small>
                </button>
              ))}
            </>
          )}

          {effectiveMode === "symbols" &&
            symbolResults.map((symbol, index) => (
              <button
                key={`${symbol.path}:${symbol.line}:${symbol.name}`}
                type="button"
                id={`coding-palette-row-${index}`}
                role="option"
                aria-selected={index === active}
                data-active={index === active}
                className="coding-palette__row"
                onMouseEnter={() => setActive(index)}
                onClick={() => commit(index)}
              >
                <span>{symbol.name}</span>
                {symbol.detail && <small>{symbol.detail}</small>}
                <small>{symbol.line}</small>
              </button>
            ))}

          {total === 0 && !pathsLoading && (
            <div className="coding-palette__empty">没有匹配项</div>
          )}
        </div>
      </div>
    </div>
  );
}
