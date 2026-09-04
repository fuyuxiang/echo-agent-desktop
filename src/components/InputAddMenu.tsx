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
type CatalogId = Exclude<MenuItemId, "add-files">;

interface MenuItem {
  id: MenuItemId;
  label: string;
  icon: React.ReactNode;
}

const MENU_GROUPS: MenuItem[][] = [
  [
    { id: "add-files", label: "点击选择文件", icon: <Paperclip size={16} /> },
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
  const triggerRef = useRef<HTMLButtonElement>(null);
  const mainItemRefs = useRef(new Map<MenuItemId, HTMLButtonElement>());
  const submenuRef = useRef<HTMLDivElement>(null);
  const loadGenerationRef = useRef(0);
  const pendingSubmenuFocusRef = useRef(false);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const leaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [experts, setExperts] = useState<AgentEntry[]>([]);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [connectors, setConnectors] = useState<McpServerEntry[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogErrors, setCatalogErrors] = useState<Partial<Record<CatalogId, string>>>({});

  const loadData = useCallback(async () => {
    const generation = ++loadGenerationRef.current;
    setCatalogLoading(true);
    setCatalogErrors({});
    const [expertResult, skillResult, connectorResult] = await Promise.allSettled([
      agentsList(),
      skillsList(),
      mcpList(),
    ]);
    if (generation !== loadGenerationRef.current) return;

    const nextErrors: Partial<Record<CatalogId, string>> = {};
    if (expertResult.status === "fulfilled") setExperts(expertResult.value);
    else nextErrors.experts = "专家加载失败";
    if (skillResult.status === "fulfilled") {
      setSkills(skillResult.value.filter((skill) => skill.enabled));
    } else {
      nextErrors.skills = "技能加载失败";
    }
    if (connectorResult.status === "fulfilled") {
      setConnectors(connectorResult.value.filter((server) => server.enabled));
    } else {
      nextErrors.connectors = "连接器加载失败";
    }
    setCatalogErrors(nextErrors);
    setCatalogLoading(false);
  }, []);

  useEffect(() => {
    if (open) void loadData();
  }, [open, loadData]);

  useEffect(() => {
    if (open) mainItemRefs.current.get("add-files")?.focus();
  }, [open]);

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
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        setHoveredItem(null);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  // Cleanup timers
  useEffect(() => {
    return () => {
      loadGenerationRef.current += 1;
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

  const close = (restoreFocus = true) => {
    pendingSubmenuFocusRef.current = false;
    setOpen(false);
    setHoveredItem(null);
    if (restoreFocus) triggerRef.current?.focus();
  };

  const focusSubmenu = () => {
    pendingSubmenuFocusRef.current = true;
    window.requestAnimationFrame(() => {
      const firstItem = submenuRef.current?.querySelector<HTMLButtonElement>('button[role="menuitem"]');
      if (firstItem) {
        firstItem.focus();
        pendingSubmenuFocusRef.current = false;
      } else {
        submenuRef.current?.focus();
      }
    });
  };

  useEffect(() => {
    if (!hoveredItem || catalogLoading || !pendingSubmenuFocusRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      const firstItem = submenuRef.current?.querySelector<HTMLButtonElement>('button[role="menuitem"]');
      (firstItem ?? submenuRef.current)?.focus();
      pendingSubmenuFocusRef.current = false;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [catalogErrors, catalogLoading, connectors, experts, hoveredItem, skills]);

  const openSubmenu = (id: Exclude<MenuItemId, "add-files">, moveFocus = false) => {
    setHoveredItem(id);
    if (moveFocus) focusSubmenu();
  };

  const handleItemClick = (id: MenuItemId) => {
    if (id === "add-files") { close(); onPickFiles(); }
    else openSubmenu(id, true);
  };

  const flatItems = MENU_GROUPS.flat();
  const handleMainKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    item: MenuItem,
    index: number,
  ) => {
    const focusAt = (nextIndex: number) => {
      const normalized = (nextIndex + flatItems.length) % flatItems.length;
      mainItemRefs.current.get(flatItems[normalized].id)?.focus();
    };
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusAt(index + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusAt(index - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      focusAt(0);
    } else if (event.key === "End") {
      event.preventDefault();
      focusAt(flatItems.length - 1);
    } else if (event.key === "ArrowRight" && item.id !== "add-files") {
      event.preventDefault();
      openSubmenu(item.id, true);
    } else if ((event.key === "Enter" || event.key === " ") && item.id !== "add-files") {
      event.preventDefault();
      openSubmenu(item.id, true);
    }
  };

  const handleSubmenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(
      submenuRef.current?.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]') ?? [],
    );
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const focusAt = (nextIndex: number) => {
      if (items.length === 0) return;
      items[(nextIndex + items.length) % items.length]?.focus();
    };
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusAt(index + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusAt(index - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      focusAt(0);
    } else if (event.key === "End") {
      event.preventDefault();
      focusAt(items.length - 1);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      const parentId = hoveredItem;
      setHoveredItem(null);
      if (parentId) mainItemRefs.current.get(parentId)?.focus();
    }
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

  const renderCatalogState = (id: CatalogId, hasItems: boolean, emptyLabel: string) => {
    const error = catalogErrors[id];
    if (error) {
      return (
        <div className="iam-sub-state iam-sub-state--error" role="none">
          <span role="alert">{error}，请重试。</span>
          <button type="button" className="iam-sub-retry" role="menuitem" onClick={() => void loadData()}>
            重试
          </button>
        </div>
      );
    }
    if (!hasItems && catalogLoading) {
      return <div className="iam-sub-empty" role="status">正在加载…</div>;
    }
    if (!hasItems) return <div className="iam-sub-empty">{emptyLabel}</div>;
    return null;
  };

  const renderSubmenu = () => {
    if (!hoveredItem) return null;

    let items: React.ReactNode = null;

    if (hoveredItem === "experts") {
      items = (
        <>
          {renderCatalogState("experts", experts.length > 0, "暂无已安装专家")}
          {experts.map((e) => (
          <button
            key={e.path || e.name}
            type="button"
            className="iam-sub-item"
            role="menuitem"
            onClick={() => handleSelectExpert(e)}
          >
            <span className="iam-sub-avatar">{(e.name || "?")[0]}</span>
            <span className="iam-sub-text">
              <span className="iam-sub-name">{e.name}</span>
              {e.description && <span className="iam-sub-desc">{e.description.slice(0, 40)}</span>}
            </span>
          </button>
          ))}
        </>
      );
    }

    if (hoveredItem === "skills") {
      items = (
        <>
          {renderCatalogState("skills", skills.length > 0, "暂无已启用技能")}
          {skills.map((s) => (
          <button
            key={s.name}
            type="button"
            className="iam-sub-item"
            role="menuitem"
            onClick={() => handleSelectSkill(s.name)}
          >
            <SkillTabIcon size="sm" />
            <span className="iam-sub-text">
              <span className="iam-sub-name">{s.displayName || s.name}</span>
              {s.description && <span className="iam-sub-desc">{s.description.slice(0, 40)}</span>}
            </span>
          </button>
          ))}
        </>
      );
    }

    if (hoveredItem === "connectors") {
      items = (
        <>
          {renderCatalogState("connectors", connectors.length > 0, "暂无已启用连接器")}
          {connectors.slice(0, 8).map((server) => (
              <button
                key={server.name}
                type="button"
                className="iam-sub-item"
                role="menuitem"
                onClick={handleSelectConnector}
              >
                <ConnectorTabIcon size="sm" />
                <span className="iam-sub-text">
                  <span className="iam-sub-name">{server.name}</span>
                  {server.target && <span className="iam-sub-desc">{server.target}</span>}
                </span>
              </button>
            ))}
          <button type="button" className="iam-sub-footer" role="menuitem" onClick={handleSelectConnector}>
            管理连接器 →
          </button>
        </>
      );
    }

    if (!items) return null;

    return (
      <div
        className="iam-submenu"
        role="menu"
        tabIndex={-1}
        aria-label={`${MENU_GROUPS.flat().find((item) => item.id === hoveredItem)?.label ?? "添加"}子菜单`}
        ref={submenuRef}
        onKeyDown={handleSubmenuKeyDown}
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
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? "composer-add-menu" : undefined}
        title="添加文件、专家、技能、连接器"
        ref={triggerRef}
      >
        <AddIcon size="md" />
      </button>

      {open && (
        <div className="iam-popover" id="composer-add-menu" role="menu" aria-label="添加内容">
          {MENU_GROUPS.map((group, gi) => (
            <div key={gi}>
              {gi > 0 && <div className="iam-divider" />}
              <div className="iam-group">
                {group.map((item) => {
                  const itemIndex = flatItems.findIndex((candidate) => candidate.id === item.id);
                  return (
                  <button
                    type="button"
                    key={item.id}
                    className={
                      "iam-item" + (hoveredItem === item.id ? " iam-item--active" : "")
                    }
                    onMouseEnter={() => handleItemEnter(item.id)}
                    onMouseLeave={handleItemLeave}
                    onClick={() => handleItemClick(item.id)}
                    role="menuitem"
                    aria-haspopup={item.id === "add-files" ? undefined : "menu"}
                    aria-expanded={item.id === "add-files" ? undefined : hoveredItem === item.id}
                    ref={(element) => {
                      if (element) mainItemRefs.current.set(item.id, element);
                      else mainItemRefs.current.delete(item.id);
                    }}
                    onKeyDown={(event) => handleMainKeyDown(event, item, itemIndex)}
                  >
                    <span className="iam-item__icon">{item.icon}</span>
                    <span className="iam-item__label">{item.label}</span>
                    {item.id !== "add-files" && (
                      <span className="iam-item__chevron">
                        <ChevronRight size={14} strokeWidth={1.5} />
                      </span>
                    )}
                  </button>
                  );
                })}
              </div>
            </div>
          ))}
          {renderSubmenu()}
        </div>
      )}
    </div>
  );
}
