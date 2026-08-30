import { useCallback, useEffect, useRef, useState } from "react";
import { Paperclip, ChevronRight } from "lucide-react";
import {
  AddIcon,
  ExpertTabIcon,
  SkillTabIcon,
  ConnectorTabIcon,
} from "@/foundation/components/Icon/icons";
import { skillsList, agentsList, mcpList } from "@/lib/agent-client";
import type { AgentEntry, McpServerEntry, SkillInfo } from "@/lib/types";

interface InputAddMenuProps {
  onPickFiles: () => void;
  onSelectExpert?: (agent: AgentEntry) => void;
  onSelectSkill?: (skillName: string) => void;
  onNavigateConnectors?: () => void;
}

type MenuItemId = "add-files" | "experts" | "skills" | "connectors";

interface MenuItem {
  id: MenuItemId;
  label: string;
  icon: React.ReactNode;
}

const MENU_GROUPS: MenuItem[][] = [
  [
    { id: "add-files", label: "添加文件", icon: <Paperclip size={16} /> },
  ],
  [
    { id: "experts", label: "专家", icon: <ExpertTabIcon size="md" /> },
    { id: "skills", label: "技能", icon: <SkillTabIcon size="md" /> },
    { id: "connectors", label: "连接器", icon: <ConnectorTabIcon size="md" /> },
  ],
];

export function InputAddMenu({
  onPickFiles,
  onSelectExpert,
  onSelectSkill,
  onNavigateConnectors,
}: InputAddMenuProps) {
  const [open, setOpen] = useState(false);
  const [hoveredItem, setHoveredItem] = useState<MenuItemId | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const leaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [experts, setExperts] = useState<AgentEntry[]>([]);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [connectors, setConnectors] = useState<McpServerEntry[]>([]);

  const loadData = useCallback(async () => {
    const [e, s, m] = await Promise.all([
      agentsList().catch(() => [] as AgentEntry[]),
      skillsList().catch(() => [] as SkillInfo[]),
      mcpList().catch(() => [] as McpServerEntry[]),
    ]);
    setExperts(e);
    setSkills(s.filter((sk) => sk.enabled));
    setConnectors(m.filter((server) => server.enabled));
  }, []);

  useEffect(() => {
    if (open) void loadData();
  }, [open, loadData]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setHoveredItem(null);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setOpen(false); setHoveredItem(null); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  // Cleanup timers
  useEffect(() => {
    return () => {
      if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
      if (leaveTimerRef.current) clearTimeout(leaveTimerRef.current);
    };
  }, []);

  const handleItemEnter = (id: MenuItemId) => {
    if (leaveTimerRef.current) { clearTimeout(leaveTimerRef.current); leaveTimerRef.current = null; }
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    // Items without submenus show immediately
    if (id === "add-files") { setHoveredItem(null); return; }
    hoverTimerRef.current = setTimeout(() => setHoveredItem(id), 150);
  };

  const handleItemLeave = () => {
    if (hoverTimerRef.current) { clearTimeout(hoverTimerRef.current); hoverTimerRef.current = null; }
    leaveTimerRef.current = setTimeout(() => setHoveredItem(null), 200);
  };

  const handleSubmenuEnter = () => {
    if (leaveTimerRef.current) { clearTimeout(leaveTimerRef.current); leaveTimerRef.current = null; }
  };

  const handleSubmenuLeave = () => {
    leaveTimerRef.current = setTimeout(() => setHoveredItem(null), 200);
  };

  const close = () => { setOpen(false); setHoveredItem(null); };

  const handleItemClick = (id: MenuItemId) => {
    if (id === "add-files") { close(); onPickFiles(); }
  };

  const handleSelectExpert = (agent: AgentEntry) => {
    close();
    onSelectExpert?.(agent);
  };

  const handleSelectSkill = (name: string) => {
    close();
    onSelectSkill?.(name);
  };

  const handleSelectConnector = () => {
    close();
    onNavigateConnectors?.();
  };

  const renderSubmenu = () => {
    if (!hoveredItem) return null;

    let items: React.ReactNode = null;

    if (hoveredItem === "experts") {
      items = experts.length > 0 ? (
        experts.map((e) => (
          <button
            key={e.path || e.name}
            type="button"
            className="iam-sub-item"
            onClick={() => handleSelectExpert(e)}
          >
            <span className="iam-sub-avatar">{(e.name || "?")[0]}</span>
            <span className="iam-sub-text">
              <span className="iam-sub-name">{e.name}</span>
              {e.description && <span className="iam-sub-desc">{e.description.slice(0, 40)}</span>}
            </span>
          </button>
        ))
      ) : (
        <div className="iam-sub-empty">暂无已安装专家</div>
      );
    }

    if (hoveredItem === "skills") {
      items = skills.length > 0 ? (
        skills.map((s) => (
          <button
            key={s.name}
            type="button"
            className="iam-sub-item"
            onClick={() => handleSelectSkill(s.name)}
          >
            <SkillTabIcon size="sm" />
            <span className="iam-sub-text">
              <span className="iam-sub-name">{s.displayName || s.name}</span>
              {s.description && <span className="iam-sub-desc">{s.description.slice(0, 40)}</span>}
            </span>
          </button>
        ))
      ) : (
        <div className="iam-sub-empty">暂无已启用技能</div>
      );
    }

    if (hoveredItem === "connectors") {
      items = (
        <>
          {connectors.length > 0 ? connectors.slice(0, 8).map((server) => (
              <button
                key={server.name}
                type="button"
                className="iam-sub-item"
                onClick={handleSelectConnector}
              >
                <ConnectorTabIcon size="sm" />
                <span className="iam-sub-text">
                  <span className="iam-sub-name">{server.name}</span>
                  {server.target && <span className="iam-sub-desc">{server.target}</span>}
                </span>
              </button>
            )) : (
              <div className="iam-sub-empty">暂无已启用连接器</div>
            )}
          <button type="button" className="iam-sub-footer" onClick={handleSelectConnector}>
            管理连接器 →
          </button>
        </>
      );
    }

    if (!items) return null;

    return (
      <div
        className="iam-submenu"
        onMouseEnter={handleSubmenuEnter}
        onMouseLeave={handleSubmenuLeave}
      >
        <div className="iam-submenu__scroll">{items}</div>
      </div>
    );
  };

  return (
    <div className="iam-wrap" ref={containerRef}>
      <button
        className="echo-composer__add"
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        aria-label="添加"
        title="添加文件、专家、技能、连接器"
      >
        <AddIcon size="md" />
      </button>

      {open && (
        <div className="iam-popover">
          {MENU_GROUPS.map((group, gi) => (
            <div key={gi}>
              {gi > 0 && <div className="iam-divider" />}
              <div className="iam-group">
                {group.map((item) => (
                  <div
                    key={item.id}
                    className={
                      "iam-item" + (hoveredItem === item.id ? " iam-item--active" : "")
                    }
                    onMouseEnter={() => handleItemEnter(item.id)}
                    onMouseLeave={handleItemLeave}
                    onClick={() => handleItemClick(item.id)}
                    role="menuitem"
                  >
                    <span className="iam-item__icon">{item.icon}</span>
                    <span className="iam-item__label">{item.label}</span>
                    {item.id !== "add-files" && (
                      <span className="iam-item__chevron">
                        <ChevronRight size={14} strokeWidth={1.5} />
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
          {renderSubmenu()}
        </div>
      )}
    </div>
  );
}
