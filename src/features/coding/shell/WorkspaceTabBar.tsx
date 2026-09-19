import { Folder, Plus } from "lucide-react";

export interface WorkspaceTabBarItem {
  cwd: string;
  sessionCount?: number;
}

interface WorkspaceTabBarProps {
  workspaces: WorkspaceTabBarItem[];
  activeCwd: string;
  onSelect: (cwd: string) => void;
  onClose: (cwd: string) => void;
  onAdd: () => void;
}

function shortName(cwd: string): string {
  if (!cwd) return "工作区";
  const parts = cwd.replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.length === 0) return cwd;
  return parts[parts.length - 1] ?? cwd;
}

/**
 * Tab strip rendered above the file tree. Visual language aligns with
 * VSCode's editor tabs (rounded top corners, active border-bottom tied to
 * content background) so users coming from other editors feel at home.
 */
export function WorkspaceTabBar({
  workspaces,
  activeCwd,
  onSelect,
  onClose,
  onAdd,
}: WorkspaceTabBarProps) {
  if (workspaces.length === 0 && !activeCwd) {
    // Render only the Add button so the strip is always visible / reachable.
    return (
      <div className="workspace-tabbar" role="tablist" aria-label="工作区">
        <button
          type="button"
          className="workspace-tab workspace-tab--add"
          onClick={onAdd}
          title="添加工作区"
          aria-label="添加工作区"
          data-testid="workspace-tab-add"
        >
          <Plus size={12} />
          <span className="workspace-tab__name">添加工作区</span>
        </button>
      </div>
    );
  }

  return (
    <div className="workspace-tabbar" role="tablist" aria-label="工作区">
      {workspaces.map((w) => {
        const active = w.cwd === activeCwd;
        return (
          <div
            key={w.cwd}
            role="tab"
            aria-selected={active}
            className={`workspace-tab${active ? " workspace-tab--active" : ""}`}
            title={w.cwd}
            data-testid={`workspace-tab-${shortName(w.cwd)}`}
            data-active={active || undefined}
          >
            <button
              type="button"
              className="workspace-tab__select"
              onClick={() => onSelect(w.cwd)}
            >
              <Folder size={12} aria-hidden />
              <span className="workspace-tab__name">{shortName(w.cwd)}</span>
            </button>
            <button
              type="button"
              className="workspace-tab__close"
              title="关闭工作区"
              aria-label={`关闭工作区 ${w.cwd}`}
              onClick={(event) => {
                event.stopPropagation();
                onClose(w.cwd);
              }}
            >
              ×
            </button>
          </div>
        );
      })}
      <button
        type="button"
        className="workspace-tab workspace-tab--add"
        onClick={onAdd}
        title="添加工作区"
        aria-label="添加工作区"
        data-testid="workspace-tab-add"
      >
        <Plus size={12} />
      </button>
    </div>
  );
}
