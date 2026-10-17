import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { create } from "zustand";
import { Archive, ArchiveRestore, CopyPlus, MoreHorizontal, Pencil, Pin, Trash2 } from "lucide-react";
import { useAppDialog } from "@/components/AppDialog";
import { Toast, type ToastAction } from "@/components/Toast";
import { groupControl, groupMetadata, groupSaveTeam, groupSnapshot, terminalWork, type Group } from "./group-client";
import { useGroupStore } from "./group-store";
import "./groups.css";

type Menu = { id: string; x: number; y: number; anchor: HTMLElement };
const useActions = create<{ menu: Menu | null; busy: Record<string, boolean> }>(() => ({ menu: null, busy: {} }));
const errorText = (error: unknown) => String(error).replace(/^Error:\s*/, "");

export function openGroupMenu(id: string, event: MouseEvent<HTMLElement>) {
  event.preventDefault(); event.stopPropagation();
  const box = event.currentTarget.getBoundingClientRect();
  useActions.setState({ menu: { id, x: event.type === "contextmenu" ? event.clientX : box.right, y: event.type === "contextmenu" ? event.clientY : box.bottom + 4, anchor: event.currentTarget } });
}

export function GroupActionButton({ group }: { group: Group }) {
  const busy = useActions(state => !!state.busy[group.id]);
  const expanded = useActions(state => state.menu?.id === group.id);
  return <button type="button" className="groups-icon group-action-trigger" aria-label={`管理专家团 ${group.name}`} aria-haspopup="menu" aria-expanded={expanded} aria-controls={expanded ? "group-action-menu" : undefined} disabled={busy} onClick={event => openGroupMenu(group.id, event)}><MoreHorizontal size={16} /></button>;
}

async function refreshGroup(id: string) {
  await useGroupStore.getState().refresh();
  if (useGroupStore.getState().currentId === id) await useGroupStore.getState().select(id);
}
async function stopBeforeArchive(id: string) {
  await groupControl(id, "stop");
  const deadline = Date.now() + 20_000;
  while ((await groupSnapshot(id)).works.some(work => !terminalWork(work.status))) {
    if (Date.now() >= deadline) throw new Error("工作仍在停止，专家团尚未归档，请稍后重试。");
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}

/** One persistent host keeps confirmations and undo available across all group surfaces. */
export function GroupActionsHost({ onFeedback }: { onFeedback?: (message: string, actions: ToastAction[]) => void } = {}) {
  const { menu } = useActions();
  const { groups, current, cleanupError } = useGroupStore();
  const [cleaning, setCleaning] = useState(false);
  const group = menu ? (current?.id === menu.id ? current : groups.find(group => group.id === menu.id)) : undefined;
  const dialog = useAppDialog();
  const [feedback, setFeedback] = useState<{ message: string; actions: ToastAction[] } | null>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const menuRef = useRef<HTMLDivElement>(null);
  const close = (restore = true) => {
    const anchor = useActions.getState().menu?.anchor;
    useActions.setState({ menu: null });
    if (restore && anchor?.isConnected) anchor.focus();
  };
  const notify = (message: string, actions: ToastAction[] = []) => { if (onFeedback) onFeedback(message, actions); else setFeedback({ message, actions }); };
  useEffect(() => {
    if (!feedback) return;
    const timeout = setTimeout(() => setFeedback(null), feedback.actions.length ? 10_000 : 6000);
    return () => clearTimeout(timeout);
  }, [feedback]);
  useEffect(() => { if (menu && !group) useActions.setState({ menu: null }); }, [menu, group]);
  useLayoutEffect(() => {
    if (!menu || !menuRef.current) return;
    const box = menuRef.current.getBoundingClientRect();
    setPosition({ left: Math.max(8, Math.min(menu.x - box.width, window.innerWidth - box.width - 8)), top: Math.max(8, Math.min(menu.y, window.innerHeight - box.height - 8)) });
    menuRef.current.querySelector<HTMLButtonElement>('button[role="menuitem"]')?.focus();
  }, [menu?.id, menu?.x, menu?.y]);
  useEffect(() => {
    if (!menu) return;
    const outside = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node)) close(false); };
    const reposition = () => close(false);
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => { document.removeEventListener("pointerdown", outside); window.removeEventListener("resize", reposition); window.removeEventListener("scroll", reposition, true); };
  }, [menu]);
  const run = async (id: string, action: () => Promise<void>) => {
    if (useActions.getState().busy[id]) throw new Error("该专家团正在处理中，请稍候。");
    useActions.setState(state => ({ busy: { ...state.busy, [id]: true } }));
    try { await action(); }
    finally { useActions.setState(state => { const busy = { ...state.busy }; delete busy[id]; return { busy }; }); }
  };
  const perform = (action: () => Promise<void>) => { void action().catch(error => notify(errorText(error))); };
  const request = (kind: "rename" | "save" | "delete" | "archive") => {
    if (!group) return;
    const target = group, returnFocus = menu?.anchor;
    close(false);
    const active = target.works.some(work => !terminalWork(work.status));
    if (kind === "rename" || kind === "save") {
      const save = kind === "save";
      dialog.requestInput({ title: save ? "保存为专家团模板" : "重命名专家团", description: save ? "保存成员、分工和模型，不包含聊天记录。同名模板会更新。" : undefined, fields: [{ name: "name", label: save ? "模板名称" : "专家团名称", defaultValue: target.name, required: true, maxLength: 80 }], confirmLabel: save ? "保存模板" : "保存名称", returnFocus, action: values => run(target.id, async () => {
        if (save) await groupSaveTeam(target.id, values.name.trim()); else await groupMetadata(target.id, { name: values.name.trim() });
        await refreshGroup(target.id); notify(save ? "已保存专家团模板" : "专家团名称已更新");
      }) });
    } else if (kind === "delete") {
      dialog.requestConfirmation({ title: `删除专家团“${target.name}”？`, description: <><p>将永久删除这个专家团的聊天、工作、决定记录及该专家团的记忆，无法恢复。个人专家、已保存模板和工作区文件会保留。</p>{target.sourceSessionId && <p>来源任务与团队会保留，可用于创建新的独立专家团。</p>}<p>{active ? "当前还有未结束的工作，将先停止工作，确认停止后再删除。" : "如果确认前有新的工作开始，将先停止工作后删除。"}</p></>, danger: true, confirmLabel: active ? "停止工作并删除" : "永久删除", returnFocus, action: () => run(target.id, async () => {
        await useGroupStore.getState().remove(target.id, true);
        requestAnimationFrame(() => {
          const next = document.querySelector<HTMLButtonElement>(".groups-page .groups-page__header .btn--primary")
            ?? document.querySelector<HTMLButtonElement>(".sidebar__nav-item--active");
          next?.focus();
        });
        const localError = useGroupStore.getState().cleanupError;
        if (!localError) notify("专家团及关联记录已删除，工作区文件已保留");
      }) });
    } else {
      const archive = async () => run(target.id, async () => {
        if (active) await stopBeforeArchive(target.id);
        await groupMetadata(target.id, { archived: true });
        await refreshGroup(target.id);
        notify("已归档专家团，可在“已归档”中恢复", [{ label: "撤销", onClick: () => perform(async () => { await groupMetadata(target.id, { archived: false }); await refreshGroup(target.id); notify("已恢复专家团"); }) }]);
      });
      if (active) dialog.requestConfirmation({ title: "停止工作并归档？", description: `“${target.name}”还有未结束的工作。停止后归档，已有聊天与工作结果会保留。`, confirmLabel: "停止工作并归档", returnFocus, action: archive });
      else perform(archive);
    }
  };
  return <>
    {menu && group && createPortal(<div ref={menuRef} id="group-action-menu" className="context-menu group-action-menu" role="menu" aria-label={`${group.name} 专家团操作`} style={{ position: "fixed", left: position.left, top: position.top, zIndex: "var(--echo-layer-popover)" }} onKeyDown={event => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]'));
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === "Escape" || event.key === "Tab") { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); } close(); }
      else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) { event.preventDefault(); event.stopPropagation(); items[event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus(); }
    }}>
      <button role="menuitem" className="context-menu__item" onClick={() => request("rename")}><Pencil size={14} />重命名</button>
      <button role="menuitem" className="context-menu__item" onClick={() => { const target = group; close(); perform(() => run(target.id, async () => { await groupMetadata(target.id, { pinned: !target.pinned }); await refreshGroup(target.id); notify(target.pinned ? "已取消置顶" : "已置顶专家团"); })); }}><Pin size={14} />{group.pinned ? "取消置顶" : "置顶"}</button>
      <button role="menuitem" className="context-menu__item" onClick={() => request("save")}><CopyPlus size={14} />保存为模板</button>
      <div className="context-menu__divider" role="separator" />
      <button role="menuitem" className="context-menu__item" onClick={() => { if (!group.archived) request("archive"); else { const target = group; close(); perform(() => run(target.id, async () => { await groupMetadata(target.id, { archived: false }); await refreshGroup(target.id); notify("已恢复专家团，已停止的工作保持停止"); })); } }}>{group.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}{group.archived ? "恢复专家团" : "归档专家团"}</button>
      <button role="menuitem" className="context-menu__item context-menu__item--danger" onClick={() => request("delete")}><Trash2 size={14} />删除专家团…</button>
    </div>, document.body)}
    {dialog.dialog}
    {cleanupError && <div className="group-cleanup-notice" role="alert"><span>{cleanupError}</span><button type="button" className="btn btn--ghost" disabled={cleaning} onClick={() => { setCleaning(true); void useGroupStore.getState().retryCleanup().finally(() => setCleaning(false)); }}>{cleaning ? "正在清理…" : "重试清理"}</button></div>}
    <Toast message={cleanupError ? null : feedback?.message ?? null} actions={feedback?.actions} onDismiss={() => setFeedback(null)} />
  </>;
}
