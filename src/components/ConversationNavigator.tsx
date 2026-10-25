import { useEffect, useRef, useState, type RefObject } from "react";
import { List } from "lucide-react";
import { readingTurnIndex, type ConversationTurn } from "@/lib/conversation-navigation";

/** Inside the transcript gutter, independent from the application's session sidebar. */
export function ConversationNavigator({ turns, scrollRef, contentRef, onSelect, onDirectory }: {
  turns: ConversationTurn[];
  scrollRef: RefObject<HTMLDivElement>;
  contentRef: RefObject<HTMLDivElement>;
  onSelect: (id: string) => void;
  onDirectory: (trigger: HTMLButtonElement) => void;
}) {
  const [readingId, setReadingId] = useState<string | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const navRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const viewport = scrollRef.current;
    if (!viewport) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const rows = new Map(Array.from(viewport.querySelectorAll<HTMLElement>("[data-msg-id]"))
        .map(row => [row.dataset.msgId, row]));
      const top = viewport.getBoundingClientRect().top;
      const tops = turns.map(turn => rows.get(turn.id)?.getBoundingClientRect().top ?? Infinity);
      const atBottom = viewport.scrollHeight > viewport.clientHeight && viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 2;
      const index = atBottom ? turns.length - 1 : readingTurnIndex(tops, top + Math.min(120, viewport.clientHeight * .25));
      setReadingId(turns[index]?.id ?? null);
    };
    const schedule = () => { if (!frame) frame = window.requestAnimationFrame(update); };
    update();
    viewport.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    if (contentRef.current) observer?.observe(contentRef.current);
    observer?.observe(viewport);
    return () => {
      viewport.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      observer?.disconnect();
      window.cancelAnimationFrame(frame);
    };
  }, [turns, scrollRef, contentRef]);
  const activeIndex = Math.max(0, turns.findIndex(turn => turn.id === readingId));
  const start = Math.max(0, Math.min(activeIndex - 5, turns.length - 11));
  const visible = turns.slice(start, start + 11);
  const preview = turns.find(turn => turn.id === previewId);
  if (turns.length < 2) return null;
  return <>
    <button type="button" className="conversation-directory-mobile" onClick={event => onDirectory(event.currentTarget)}><List size={14} />对话目录 <span>{turns.length}</span></button>
    <nav className="conversation-nav" aria-label="当前会话轮次导航" ref={navRef}
      onMouseLeave={() => { if (!navRef.current?.contains(document.activeElement)) setPreviewId(null); }}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setPreviewId(null); }}
      onKeyDown={event => {
        if (event.key === "Escape") { setPreviewId(null); return; }
        if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
        const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>(".conversation-nav__mark"));
        const index = buttons.indexOf(event.target as HTMLButtonElement);
        if (index < 0) return;
        event.preventDefault();
        const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
          : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }}>
      <button type="button" className="conversation-nav__directory" aria-label={`对话目录，共 ${turns.length} 轮`} data-tip="对话目录" onClick={event => onDirectory(event.currentTarget)}><List size={14} /></button>
      {visible.map(turn => <button key={turn.id} type="button" className="conversation-nav__mark" aria-label={`第 ${turn.order} 轮：${turn.preview}`}
        aria-current={turn.id === readingId ? "step" : undefined}
        onMouseEnter={() => setPreviewId(turn.id)} onFocus={() => setPreviewId(turn.id)}
        onClick={() => { setPreviewId(null); onSelect(turn.id); }}><span /></button>)}
      {preview && <div className="conversation-nav__preview" role="group" aria-label={`第 ${preview.order} 轮预览`}>
        <span className="conversation-nav__meta">第 {preview.order} 轮 · {preview.status}</span>
        <strong>{preview.preview}</strong>
        {preview.answer && <p>{preview.answer}</p>}
        <button type="button" onClick={() => { setPreviewId(null); onSelect(preview.id); }}>查看该轮 <span aria-hidden="true">→</span></button>
      </div>}
    </nav>
  </>;
}
