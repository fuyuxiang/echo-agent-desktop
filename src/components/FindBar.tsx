/**
 * 会话内查找条 —— 对齐 EchoAgent `echo-chat-ui/chat-search`(extract-plain-text + 跳转高亮)。
 *
 * 在当前对话的消息列表中查找关键词(大小写不敏感),按「出现处」维度计数与导航:
 * 同一条消息中多次命中会展开为多次 occurrence,跨消息累计总命中数。
 * 命中列表由调用方从最终渲染 DOM 收集，确保计数、导航与实际高亮完全一致。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  XCloseIcon,
} from "@/foundation/components/Icon/icons";

/** 单次出现的定位信息。 */
export interface FindOccurrence {
  /** 所在消息 id。 */
  messageId: string;
  /** 该消息内第几次出现(0-based)。 */
  localIndex: number;
}

interface FindBarProps {
  /** 从最终渲染结果收集到的全部命中。 */
  occurrences: FindOccurrence[];
  /** 受控开关。 */
  open: boolean;
  /** 当前查询内容(受控)。 */
  query: string;
  /** 查询内容变化回调。 */
  onQueryChange: (next: string) => void;
  /** 关闭回调。 */
  onClose: () => void;
  /** 当前激活的出现处。null 表示无命中/空 query。 */
  onActiveChange?: (info: FindOccurrence | null) => void;
}

export function FindBar({
  occurrences,
  open,
  query,
  onQueryChange,
  onClose,
  onActiveChange,
}: FindBarProps) {
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const total = occurrences.length;
  const effectiveActiveIdx = total > 0 ? Math.min(activeIdx, total - 1) : 0;
  const active: FindOccurrence | null = total > 0
    ? occurrences[effectiveActiveIdx]
    : null;

  // query 变化时回到第一条命中。
  useEffect(() => {
    setActiveIdx(0);
  }, [query]);

  // 暴露当前命中给父级(用于滚动 + 高亮)。
  useEffect(() => {
    onActiveChange?.(active);
  }, [active, onActiveChange]);

  // 打开时聚焦输入框。
  useEffect(() => {
    if (open) {
      const t = setTimeout(() => inputRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }
  }, [open]);

  const step = useCallback(
    (dir: 1 | -1) => {
      if (total === 0) return;
      setActiveIdx((effectiveActiveIdx + dir + total) % total);
    },
    [effectiveActiveIdx, total],
  );

  // 键盘:Enter 下一个,Shift+Enter 上一个,Esc 关闭。
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      step(e.shiftKey ? -1 : 1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  if (!open) return null;

  return (
    <div className="findbar" role="search">
      <input
        ref={inputRef}
        className="findbar__input"
        type="text"
        value={query}
        placeholder="在当前对话中查找…"
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={onKeyDown}
        aria-label="查找"
      />
      <span className="findbar__count">
        {query ? (total > 0 ? `${effectiveActiveIdx + 1}/${total}` : "0/0") : ""}
      </span>
      <button
        type="button"
        className="findbar__btn"
        onClick={() => step(-1)}
        disabled={total === 0}
        title="上一个(Shift+Enter)"
        aria-label="上一个"
      >
        <ChevronLeftIcon size="sm" />
      </button>
      <button
        type="button"
        className="findbar__btn"
        onClick={() => step(1)}
        disabled={total === 0}
        title="下一个(Enter)"
        aria-label="下一个"
      >
        <ChevronDownIcon size="sm" />
      </button>
      <button
        type="button"
        className="findbar__btn"
        onClick={onClose}
        title="关闭(Esc)"
        aria-label="关闭查找"
      >
        <XCloseIcon size="sm" />
      </button>
    </div>
  );
}

/** 供调用方判断某条消息是否命中(高亮容器)。 */
export function isFindHit(hitIds: string[], messageId: string): boolean {
  return hitIds.includes(messageId);
}
