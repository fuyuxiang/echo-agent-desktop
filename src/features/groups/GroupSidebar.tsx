import { useState } from "react";
import { Users, Pin, ChevronDown, MoreHorizontal } from "lucide-react";
import { useGroupStore } from "./group-store";
import { groupStatus } from "./group-client";
import "./groups.css";

export function GroupSidebar({ onOpen, active = false }: { onOpen: () => void; active?: boolean }) {
  const groups = useGroupStore(state => state.groups);
  const currentId = useGroupStore(state => state.currentId);
  const read = useGroupStore(state => state.readRevisions);
  const [collapsed, setCollapsed] = useState(false);
  const visible = [...groups].filter(group => !group.archived).sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
  if (!visible.length) return null;
  return <section className="group-sidebar" aria-label="团队群聊">
    <div className="group-sidebar__head"><button className="group-sidebar__title" aria-expanded={!collapsed} aria-controls="sidebar-group-list" onClick={() => setCollapsed(value => !value)}><ChevronDown size={12} style={{ transform: collapsed ? "rotate(-90deg)" : undefined }} /><Users size={14} />团队群聊 ({visible.length})</button><button className="group-sidebar__all" aria-label="查看全部群聊" title="查看全部群聊" onClick={() => { void useGroupStore.getState().select(null); onOpen(); }}><MoreHorizontal size={16} /></button></div>
    {!collapsed && <div id="sidebar-group-list" className="group-sidebar__list" role="region" aria-label="最近群聊" tabIndex={0}>
    {visible.slice(0, 12).map(group => <button key={group.id} className={`group-sidebar__item${active && currentId === group.id ? " is-selected" : ""}`} onClick={() => { void useGroupStore.getState().select(group.id); onOpen(); }}>
      <span>{group.pinned && <Pin size={11} />}{group.name}{group.revision > (read[group.id] ?? 0) && <i className="group-unread" aria-label="有新动态" />}</span><small>{groupStatus(group)}</small>
    </button>)}
    </div>}
  </section>;
}
