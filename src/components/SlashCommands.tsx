/**
 * Slash 命令补全菜单 - Composer 输入 / 时弹出
 *
 * 数据来自 EchoAgent 的 `echo.agent/commands/list`（builtin + skills + plugins 注入的命令）。
 * 用户选中后会把命令名插入到 Composer 输入框。
 */
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useState,
} from "react";
import { commandsList } from "@/lib/agent-client";
import type { SlashCommand } from "@/lib/types";
import {
  SLASH_COMMAND_PAGE_SIZE,
  availableClientSlashCommands,
  mergeSlashCommands,
  slashCommandSourceLabel,
  slashTokenAtCursor,
} from "@/lib/slash-commands";

interface SlashCommandsProps {
  /** 当前的输入文本（Composer 的 value）。 */
  text: string;
  /** 光标位置。 */
  cursor: number;
  /** Active runtime session; enables session-gated commands. */
  sessionId?: string;
  /** Working directory used for project Skills and Plugins before a session exists. */
  cwd?: string;
  /** Increment when the runtime advertises a refreshed command catalog. */
  refreshKey?: number;
  /** 选中某命令时的回调，参数是完整命令文本（如 "/commit"）。 */
  onPick: (command: string) => void;
}

export interface SlashCommandsHandle {
  handleKeyDown: (event: Pick<KeyboardEvent, "key" | "preventDefault">) => boolean;
}

export const SlashCommands = forwardRef<SlashCommandsHandle, SlashCommandsProps>(function SlashCommands(
  { text, cursor, sessionId, cwd, refreshKey = 0, onPick },
  ref,
) {
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const [activeIdx, setActiveIdx] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [requestNonce, setRequestNonce] = useState(0);
  const [dismissedToken, setDismissedToken] = useState<string | null>(null);

  const token = slashTokenAtCursor(text, cursor);
  const tokenKey = token ? `${token.start}:${token.end}:${token.value}` : "";

  // Refresh on every palette open and whenever the active session/runtime
  // catalog changes. A failed request is retryable instead of poisoning the
  // component for the rest of its lifetime.
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    commandsList(sessionId, cwd)
      .then((runtimeCommands) => {
        if (cancelled) return;
        setCommands(mergeSlashCommands(
          availableClientSlashCommands(!!sessionId),
          runtimeCommands,
        ));
      })
      .catch((error) => {
        if (cancelled) return;
        // Client-owned commands remain usable even when the runtime catalog is
        // temporarily unavailable.
        setCommands(availableClientSlashCommands(!!sessionId));
        setLoadError(String(error).replace(/^Error:\s*/, ""));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  // tokenKey deliberately changes only when the token itself changes. Typing
  // within the query filters locally; reopening `/` performs a fresh request.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!token, sessionId, cwd, refreshKey, requestNonce]);

  useEffect(() => {
    if (dismissedToken && dismissedToken !== tokenKey) setDismissedToken(null);
  }, [dismissedToken, tokenKey]);

  const { visible, query, matches } = useMemo(() => {
    if (!token || dismissedToken === tokenKey) {
      return { visible: false, query: "", matches: [] as SlashCommand[] };
    }
    const q = token.query;
    const m = commands.filter(
      (c) =>
        !q ||
        c.name.toLowerCase().includes(q) ||
        (c.description ?? "").toLowerCase().includes(q),
    );
    return { visible: true, query: q, matches: m.slice(0, SLASH_COMMAND_PAGE_SIZE) };
  }, [commands, dismissedToken, token, tokenKey]);

  useEffect(() => {
    setActiveIdx(0);
  }, [query]);

  // A live catalog refresh can shrink the filtered list without changing the
  // query. Keep Enter/Tab selection inside the rows that are actually visible.
  useEffect(() => {
    setActiveIdx((index) => matches.length === 0 ? 0 : Math.min(index, matches.length - 1));
  }, [matches.length]);

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
      () => setDismissedToken(tokenKey),
      visible,
    ),
  }), [activeIdx, matches, onPick, tokenKey, visible]);

  if (!visible) return null;

  return (
    <div className="slash-commands" role="listbox">
      <div className="slash-commands__header">命令（桌面 / 内置 / 技能 / 插件 / 工作流）</div>
      <ul className="slash-commands__list">
        {matches.map((cmd, idx) => (
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
              {cmd.argumentHint && (
                <span className="slash-commands__hint">{cmd.argumentHint}</span>
              )}
              {slashCommandSourceLabel(cmd.source) && (
                <span className="slash-commands__source">{slashCommandSourceLabel(cmd.source)}</span>
              )}
            </button>
          </li>
        ))}
        {!loading && matches.length === 0 && !loadError && (
          <li className="slash-commands__empty">没有匹配的命令</li>
        )}
        {loading && <li className="slash-commands__empty">正在加载命令…</li>}
        {loadError && (
          <li className="slash-commands__error" role="status">
            <span>运行时命令加载失败：{loadError}</span>
            <button type="button" onClick={() => setRequestNonce((value) => value + 1)}>
              重试
            </button>
          </li>
        )}
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
  onDismiss: () => void = () => {},
  menuVisible = matchCount > 0,
): boolean {
  if (menuVisible && e.key === "Escape") {
    e.preventDefault();
    onDismiss();
    return true;
  }
  if (matchCount === 0) {
    if (menuVisible && ["ArrowDown", "ArrowUp", "Enter", "Tab"].includes(e.key)) {
      e.preventDefault();
      return true;
    }
    return false;
  }
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
