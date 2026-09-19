import {
  forwardRef,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { FileText, FunctionSquare } from "lucide-react";

import { atTokenAtCursor } from "@/lib/at-commands";

/**
 * Lightweight shape describing the symbols index exposes to the workbench.
 * Mirrors the backend `SymbolRecord` (`src-tauri/src/coding/symbols.rs:55-100`).
 */
export interface AtMentionSymbol {
  name: string;
  file: string;
  line: number;
  column?: number;
}

interface AtMentionMenuProps {
  /** Full textarea content (so we can re-derive the active token). */
  text: string;
  /** Caret position passed in by the parent on every onChange/onSelect. */
  cursor: number;
  /** Workspace-relative file paths (from `buildFileIndex`). */
  filePaths: string[];
  /** Already-loaded symbols (from `SymbolIndexClient`). */
  workspaceSymbols: AtMentionSymbol[];
  /** Called with the chosen mention string and a replacement-friendly form. */
  onPick: (mention: string, replacement: string) => void;
}

export interface AtMentionHandle {
  /** Returns true when the menu consumed the key event. */
  handleKeyDown: (event: { key: string; preventDefault: () => void }) => boolean;
}

interface Match {
  kind: "file" | "symbol";
  label: string;
  hint?: string;
  mention: string;
  replacement: string;
}

const FILE_LIMIT = 8;
const SYMBOL_LIMIT = 8;
const TOTAL_LIMIT = 12;

function atMenuKeyHandler(
  event: { key: string; preventDefault: () => void },
  matchCount: number,
  activeIdx: number,
  setActiveIdx: (n: number) => void,
  onPickActive: () => void,
  onDismiss: () => void,
): boolean {
  if (matchCount === 0) {
    if (event.key === "Escape") {
      event.preventDefault();
      onDismiss();
      return true;
    }
    return false;
  }
  switch (event.key) {
    case "ArrowDown":
      event.preventDefault();
      setActiveIdx((activeIdx + 1) % matchCount);
      return true;
    case "ArrowUp":
      event.preventDefault();
      setActiveIdx((activeIdx - 1 + matchCount) % matchCount);
      return true;
    case "Home":
      event.preventDefault();
      setActiveIdx(0);
      return true;
    case "End":
      event.preventDefault();
      setActiveIdx(matchCount - 1);
      return true;
    case "Enter":
    case "Tab":
      event.preventDefault();
      onPickActive();
      return true;
    case "Escape":
      event.preventDefault();
      onDismiss();
      return true;
    default:
      return false;
  }
}

/**
 * Inline candidate picker for "@…" mentions in the Composer textarea. Renders
 * nothing when there is no active mention token; otherwise a small floating
 * list of up to `TOTAL_LIMIT` entries (files first, symbols after) that the
 * parent textarea can navigate via `handleKeyDown`.
 */
export const AtMentionMenu = forwardRef<AtMentionHandle, AtMentionMenuProps>(
  function AtMentionMenu(
    { text, cursor, filePaths, workspaceSymbols, onPick },
    ref,
  ) {
    const [activeIdx, setActiveIdx] = useState(0);

    const matches: Match[] = useMemo(() => {
      const token = atTokenAtCursor(text, cursor);
      if (!token) return [];
      const q = token.query;
      const fileHits: Match[] = filePaths
        .filter((p) => !q || p.toLowerCase().includes(q))
        .slice(0, FILE_LIMIT)
        .map((p) => ({
          kind: "file",
          label: p,
          mention: "@" + p,
          replacement: p,
        }));
      const symHits: Match[] = workspaceSymbols
        .filter((s) => !q || s.name.toLowerCase().includes(q))
        .slice(0, SYMBOL_LIMIT)
        .map((s) => ({
          kind: "symbol",
          label: s.name,
          hint: `${s.file}:${s.line}`,
          mention: "@" + s.file + "#" + s.name,
          replacement: `${s.file}#${s.name}`,
        }));
      return [...fileHits, ...symHits].slice(0, TOTAL_LIMIT);
    }, [text, cursor, filePaths, workspaceSymbols]);

    const activeIdxRef = useRef(activeIdx);
    activeIdxRef.current = activeIdx;

    useImperativeHandle(
      ref,
      () => ({
        handleKeyDown: (event) =>
          atMenuKeyHandler(
            event,
            matches.length,
            activeIdxRef.current,
            setActiveIdx,
            () => {
              const m = matches[activeIdxRef.current];
              if (m) onPick(m.mention, m.replacement);
            },
            () => setActiveIdx(0),
          ),
      }),
      [matches, onPick],
    );

    if (matches.length === 0) return null;

    return (
      <div
        className="at-menu"
        role="listbox"
        aria-label="引用工作区文件或符号"
        data-testid="at-menu"
      >
        <div className="at-menu__header">引用工作区文件或符号</div>
        <ul className="at-menu__list">
          {matches.map((m, idx) => {
            const active = idx === activeIdx;
            return (
              <li key={`${m.kind}:${m.replacement}`}>
                <button
                  type="button"
                  className={`at-menu__item${active ? " at-menu__item--active" : ""}`}
                  role="option"
                  aria-selected={active}
                  data-testid="at-menu-item"
                  data-kind={m.kind}
                  onClick={() => onPick(m.mention, m.replacement)}
                  onMouseEnter={() => setActiveIdx(idx)}
                >
                  {m.kind === "file" ? (
                    <FileText size={12} aria-hidden />
                  ) : (
                    <FunctionSquare size={12} aria-hidden />
                  )}
                  <span className="at-menu__label">{m.label}</span>
                  {m.hint ? <span className="at-menu__hint">{m.hint}</span> : null}
                  <span className="at-menu__kind">
                    {m.kind === "file" ? "文件" : "符号"}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    );
  },
);

export function AtMentionMenuEmpty(): ReactNode {
  return null;
}
