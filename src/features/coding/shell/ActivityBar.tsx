import { FileCode2, GitCompareArrows, PackageSearch, Search } from "lucide-react";

import type { ActivityView } from "../store/workbench-store";

interface ActivityBarProps {
  active: ActivityView;
  onChange: (view: ActivityView) => void;
  /** Badge counts shown on the icons. */
  changeCount?: number;
  contextCount?: number;
}

const ITEMS: Array<{ id: ActivityView; label: string; Icon: typeof Search }> = [
  { id: "files", label: "资源管理器", Icon: FileCode2 },
  { id: "search", label: "搜索", Icon: Search },
  { id: "changes", label: "任务变更", Icon: GitCompareArrows },
  { id: "context", label: "上下文包", Icon: PackageSearch },
];

/** Primary work modes. File outline stays inside Explorer; workspace symbols use Quick Open. */
export function ActivityBar({ active, onChange, changeCount = 0, contextCount = 0 }: ActivityBarProps) {
  return (
    <nav className="coding-activity" aria-label="活动栏">
      {ITEMS.map(({ id, label, Icon }) => {
        const badge = id === "changes" ? changeCount : id === "context" ? contextCount : 0;
        return (
          <button
            key={id}
            type="button"
            className={active === id ? "is-active" : ""}
            aria-label={label}
            aria-current={active === id}
            title={label}
            onClick={() => onChange(id)}
          >
            <Icon size={18} />
            {badge > 0 && <b aria-hidden="true">{badge > 99 ? "99+" : badge}</b>}
          </button>
        );
      })}
    </nav>
  );
}
