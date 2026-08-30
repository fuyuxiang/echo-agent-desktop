/**
 * Slash 命令补全菜单 - Composer 输入 / 时弹出
 *
 * 数据来自 EchoAgent 的 `x.ai/commands/list`（builtin + skills + plugins 注入的命令）。
 * 用户选中后会把命令名插入到 Composer 输入框。
 */
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { commandsList } from "@/lib/agent-client";
import type { SlashCommand } from "@/lib/types";

interface SlashCommandsProps {
  /** 当前的输入文本（Composer 的 value）。 */
  text: string;
  /** 光标位置。 */
  cursor: number;
  /** 选中某命令时的回调，参数是完整命令文本（如 "/commit"）。 */
  onPick: (command: string) => void;
}

export interface SlashCommandsHandle {
  handleKeyDown: (event: Pick<KeyboardEvent, "key" | "preventDefault">) => boolean;
}

export const SlashCommands = forwardRef<SlashCommandsHandle, SlashCommandsProps>(function SlashCommands(
  { text, cursor, onPick },
  ref,
) {
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const [activeIdx, setActiveIdx] = useState(0);
  const loadedRef = useRef(false);

  const token = text.slice(0, cursor).match(/\/[^\s/]*$/)?.[0] ?? "";

  // Commands are only needed after the user starts a slash token. This avoids
  // a backend round-trip for every Composer mounted on screen.
  useEffect(() => {
    if (!token.startsWith("/") || loadedRef.current) return;
    loadedRef.current = true;
    commandsList()
      .then(setCommands)
      .catch(() => setCommands([]));
  }, [token]);

  // Detect if the user just typed "/xxx" at the start of a token.
  const { visible, query, matches } = useMemo(() => {
    // Find the start of the current "word" (back to whitespace or start).
    const before = text.slice(0, cursor);
    const wordStart = before.search(/[/\S]*$/);
    if (wordStart === -1) {
      return { visible: false, query: "", matches: [] as SlashCommand[] };
    }
    const word = before.slice(wordStart);
    if (!word.startsWith("/") || word.includes(" ") || word.length < 1) {
      return { visible: false, query: "", matches: [] as SlashCommand[] };
    }
    const q = word.slice(1).toLowerCase();
    const m = commands.filter(
      (c) =>
        !q ||
        c.name.toLowerCase().includes(q) ||
        (c.description ?? "").toLowerCase().includes(q),
    );
    return { visible: m.length > 0, query: q, matches: m };
  }, [text, cursor, commands]);

  useEffect(() => {
    setActiveIdx(0);
  }, [query]);

  useImperativeHandle(ref, () => ({
    handleKeyDown: (event) => slashCommandsKeyHandler(
      event,
      visible ? matches.length : 0,
      activeIdx,
      setActiveIdx,
      () => {
        const command = matches[activeIdx];
        if (command) onPick(`/${command.name}`);
      },
    ),
  }), [activeIdx, matches, onPick, visible]);

  if (!visible) return null;

  return (
    <div className="slash-commands" role="listbox">
      <div className="slash-commands__header">命令（来自 EchoAgent 内置/技能/插件）</div>
      <ul className="slash-commands__list">
        {matches.slice(0, 12).map((cmd, idx) => (
          <li key={cmd.name}>
            <button
              type="button"
              className={`slash-commands__item ${idx === activeIdx ? "slash-commands__item--active" : ""}`}
              onClick={() => onPick(`/${cmd.name}`)}
              onMouseEnter={() => setActiveIdx(idx)}
            >
              <span className="slash-commands__name">/{cmd.name}</span>
              {cmd.description && (
                <span className="slash-commands__desc">{cmd.description}</span>
              )}
              {cmd.source && (
                <span className="slash-commands__source">{cmd.source}</span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
});

/** Expose a keyboard handler so the Composer can route ↑↓Enter to the menu.
 *  Returns true if the key was consumed. */
export function slashCommandsKeyHandler(
  e: Pick<KeyboardEvent, "key" | "preventDefault">,
  matchCount: number,
  activeIdx: number,
  setActiveIdx: (n: number) => void,
  onPickActive: () => void,
): boolean {
  if (matchCount === 0) return false;
  if (e.key === "ArrowDown") {
    e.preventDefault();
    setActiveIdx((activeIdx + 1) % matchCount);
    return true;
  }
  if (e.key === "ArrowUp") {
    e.preventDefault();
    setActiveIdx((activeIdx - 1 + matchCount) % matchCount);
    return true;
  }
  if (e.key === "Enter" || e.key === "Tab") {
    e.preventDefault();
    onPickActive();
    return true;
  }
  return false;
}
