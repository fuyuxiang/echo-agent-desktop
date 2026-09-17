/**
 * 会话内查找条 —— 对齐 EchoAgent `echo-chat-ui/chat-search`(extract-plain-text + 跳转高亮)。
 *
 * 在当前对话的消息列表中查找关键词(大小写不敏感),按「出现处」维度计数与导航:
 * 同一条消息中多次命中会展开为多次 occurrence,跨消息累计总命中数。
 * 命中消息的容器高亮由调用方按 `hitIds` 实现,文本节点级高亮由调用方按 `findQuery` + activeLocalIndex 实现。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  XCloseIcon,
} from "@/foundation/components/Icon/icons";
import { extractPlainText } from "@/lib/extract-text";
import type { ChatMessage } from "@/stores/session-store";

/** 单次出现的定位信息。 */
export interface FindOccurrence {
  /** 所在消息 id。 */
  messageId: string;
  /** 该消息内第几次出现(0-based)。 */
  localIndex: number;
}

interface FindBarProps {
  /** 当前对话的全部消息(按时间顺序)。 */
  messages: ChatMessage[];
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
  /** 命中集合变化(供父级高亮命中容器 + 计数徽标)。 */
  onHitsChange?: (info: { hitIds: string[]; occurrences: FindOccurrence[] }) => void;
}

export function FindBar({
  messages,
  open,
  query,
  onQueryChange,
  onClose,
  onActiveChange,
  onHitsChange,
}: FindBarProps) {
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // 按消息顺序累计所有出现处(每条消息内 0-based 索引)。
  const occurrences = useMemo<FindOccurrence[]>(() => {
    if (!query) return [];
    const re = new RegExp(escapeRegex(query), "gi");
    const out: FindOccurrence[] = [];
    for (const m of messages) {
      const text = extractPlainText(m);
      let localIdx = 0;
      let hit: RegExpExecArray | null;
      re.lastIndex = 0;
      while ((hit = re.exec(text)) !== null) {
        out.push({ messageId: m.id, localIndex: localIdx });
        localIdx += 1;
        if (hit[0].length === 0) re.lastIndex += 1;
      }
    }
    return out;
  }, [messages, query]);

  // 去重的消息 id 集合,供父级沿用容器高亮。
  const hitIds = useMemo(() => {
    const seen = new Set<string>();
    const list: string[] = [];
    for (const o of occurrences) {
      if (!seen.has(o.messageId)) {
        seen.add(o.messageId);
        list.push(o.messageId);
      }
    }
    return list;
  }, [occurrences]);

  const total = occurrences.length;
  const active: FindOccurrence | null = total > 0 ? occurrences[activeIdx] : null;

  // query 变化时回到第一条命中。
  useEffect(() => {
    setActiveIdx(0);
  }, [query]);

  // 暴露当前命中给父级(用于滚动 + 高亮)。
  useEffect(() => {
    onActiveChange?.(active);
  }, [active, onActiveChange]);

  // 暴露命中集合(供父级高亮命中容器 + 计数徽标)。
  useEffect(() => {
    onHitsChange?.({ hitIds, occurrences });
  }, [hitIds, occurrences, onHitsChange]);

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
      setActiveIdx((i) => (i + dir + total) % total);
    },
    [total],
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
        {query ? (total > 0 ? `${activeIdx + 1}/${total}` : "0/0") : ""}
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

/** 转义正则元字符,避免 query 中的 `(`, `.` 等破坏 RegExp 构造。 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 供调用方判断某条消息是否命中(高亮容器)。 */
export function isFindHit(hitIds: string[], messageId: string): boolean {
  return hitIds.includes(messageId);
}
