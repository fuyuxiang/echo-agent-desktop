import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Search, X } from "lucide-react";
import type { ChatMessage } from "@/stores/session-store";
import { attachmentBasename, stripInjectedUserContext } from "@/lib/user-message";

export interface QuestionHistoryItem {
  id: string;
  order: number;
  text: string;
  preview: string;
}

/** Build the navigator from the same user-visible turns rendered in chat. */
export function buildQuestionHistory(messages: ChatMessage[]): QuestionHistoryItem[] {
  const items: QuestionHistoryItem[] = [];
  for (const message of messages) {
    if (message.role !== "user") continue;
    const text = stripInjectedUserContext(message.parts
      .filter((part) => part.kind === "text")
      .map((part) => part.text)
      .join("\n"))
      .replace(/\s+/g, " ")
      .trim();
    const attachments = (message.attachments ?? []).map(attachmentBasename);
    const label = text || (attachments.length > 0 ? `附件：${attachments.join("、")}` : "无文字内容");
    items.push({
      id: message.id,
      order: items.length + 1,
      text: label,
      preview: label.length > 180 ? `${label.slice(0, 180)}…` : label,
    });
  }
  return items.reverse();
}

export function QuestionHistoryPopover({
  items,
  triggerRef,
  onSelect,
  onClose,
  onFind,
}: {
  items: QuestionHistoryItem[];
  triggerRef: RefObject<HTMLButtonElement>;
  onSelect: (messageId: string) => void;
  onClose: () => void;
  onFind: () => void;
}) {
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const visible = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return normalized
      ? items.filter((item) => item.text.toLocaleLowerCase().includes(normalized))
      : items;
  }, [items, query]);

  useEffect(() => {
    inputRef.current?.focus();
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !triggerRef.current?.contains(target)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        onFind();
        return;
      }
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose, onFind, triggerRef]);

  return (
    <div ref={rootRef} id="question-history-popover" className="question-history" role="dialog" aria-label="历史提问">
      <div className="question-history__header">
        <strong>历史提问 <span>{items.length}</span></strong>
        <button type="button" className="question-history__close" onClick={() => { onClose(); triggerRef.current?.focus(); }} aria-label="关闭历史提问"><X size={16} /></button>
      </div>
      {items.length > 0 && (
        <label className="question-history__search">
          <Search size={15} aria-hidden="true" />
          <input ref={inputRef} type="search" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
            if (event.key !== "ArrowDown") return;
            const first = rootRef.current?.querySelector<HTMLButtonElement>(".question-history__item");
            if (first) { event.preventDefault(); first.focus(); }
          }} placeholder="筛选本会话提问" aria-label="筛选历史提问" />
        </label>
      )}
      <div className="question-history__list" role="group" aria-label="提问列表" onKeyDown={(event) => {
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        const rows = Array.from(rootRef.current?.querySelectorAll<HTMLButtonElement>(".question-history__item") ?? []);
        if (rows.length === 0) return;
        event.preventDefault();
        const current = rows.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "Home" ? 0
          : event.key === "End" ? rows.length - 1
            : event.key === "ArrowDown" ? (current + 1) % rows.length
              : (current - 1 + rows.length) % rows.length;
        rows[next]?.focus();
      }}>
        {visible.length === 0 ? (
          <p className="question-history__empty">{items.length === 0 ? "当前会话还没有提问" : "没有匹配的提问"}</p>
        ) : visible.map((item) => (
          <button type="button" className="question-history__item" key={item.id} onClick={() => onSelect(item.id)} title={item.preview}>
            <span className="question-history__order">{item.order}</span>
            <span className="question-history__text">{item.preview}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
