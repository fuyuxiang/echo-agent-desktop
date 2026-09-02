/**
 * 项目面板 — 对齐 EchoAgent 项目列表页 + 新建项目弹窗。
 *
 *  - hero: 标题「项目」+ 副标题 + 「新建项目」+ 协作插画
 *  - 我的项目: 搜索 + 卡片网格（点击进入详情）
 *  - 从模版创建: 业务模板卡片
 *  - CreateProjectDialog: 对齐目标截图（项目名称 + 指令[选择模板] + 连接器/专家/技能 +添加 + 取消/确定）
 *  - 内部 openId 切换 列表 / ProjectDetailView（无需改 App 路由）
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import { AddIcon, SearchIcon, MoreDotsIcon, ChevronDownIcon } from "@/foundation/components/Icon/icons";
import heroImg from "@/assets/landing-hero.png";
import { useProjectsStore, type ProjectMeta, type RefItem } from "@/stores/projects-store";
import {
  TEMPLATE_OPTIONS,
  getTemplate,
  ConfigRow,
  RefPickerDialog,
  useOutsideClose,
  useProjectPickerOptions,
  type ProjectPickerOptions,
} from "./project-picker";
import { ProjectDetailView } from "./ProjectDetailView";
import { projectAssetsRemoveAll } from "@/lib/agent-client";

interface ProjectsPanelProps {
  cwd?: string;
  onSelectWorkspace?: (cwd: string) => void;
  onToast?: (msg: string) => void;
  onStartProject?: (project: ProjectMeta) => void;
  /** Start a new conversation within a project (creates a real EchoAgent session). */
  onStartProjectConversation?: (projectId: string, message: string) => Promise<string | undefined>;
  onOpenSession?: (sessionId: string, cwd?: string) => void;
  onOpenAutomation?: () => void;
}

const FROM_TEMPLATES = TEMPLATE_OPTIONS.filter((t) => t.id !== "custom");
const PROJECT_MENU_MARGIN = 8;
const PROJECT_MENU_OFFSET = 4;
const PROJECT_MENU_ESTIMATED_WIDTH = 140;
const PROJECT_MENU_ESTIMATED_HEIGHT = 150;
const PROJECT_MENU_Z_INDEX = 1200;

interface ProjectMenuPosition {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
  placement: "top" | "bottom";
}

export function ProjectsPanel({ cwd, onToast, onStartProject, onStartProjectConversation, onOpenSession, onOpenAutomation }: ProjectsPanelProps) {
  const projects = useProjectsStore((s) => s.projects);
  const persisting = useProjectsStore((s) => s.persisting);
  const persistError = useProjectsStore((s) => s.persistError);
  const retryPersist = useProjectsStore((s) => s.retryPersist);
  const rename = useProjectsStore((s) => s.rename);
  const remove = useProjectsStore((s) => s.remove);
  const activeProjectId = useProjectsStore((s) => s.activeProjectId);
  const setActiveProjectId = useProjectsStore((s) => s.setActiveProjectId);
  const [query, setQuery] = useState("");
  const [create, setCreate] = useState<CreatePreset | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const picker = useProjectPickerOptions(cwd);

  // Auto-open a project when navigated from the sidebar.
  useEffect(() => {
    if (activeProjectId) {
      setOpenId(activeProjectId);
      setActiveProjectId(null);
    }
  }, [activeProjectId, setActiveProjectId]);

  const filtered = projects.filter((p) =>
    p.name.toLowerCase().includes(query.toLowerCase()),
  );

  const openProject = projects.find((p) => p.id === openId) ?? null;
  if (openProject) {
    return (
      <ProjectDetailView
        project={openProject}
        onBack={() => setOpenId(null)}
        onToast={onToast}
        onStartConversation={onStartProjectConversation}
        onOpenSession={onOpenSession}
        picker={picker}
        onOpenAutomation={onOpenAutomation}
      />
    );
  }

  const handleRename = (p: ProjectMeta) => {
    const next = window.prompt("重命名项目", p.name);
    if (next && next.trim() && next.trim() !== p.name) rename(p.id, next.trim());
  };
  const handleDelete = async (p: ProjectMeta) => {
    const detail = p.assets.length > 0
      ? `\n项目中的 ${p.assets.length} 项资产副本也会删除。`
      : "";
    if (window.confirm(`确定删除项目「${p.name}」？${detail}\n原始文件和历史会话不会被删除。`)) {
      try {
        await projectAssetsRemoveAll(p.id);
      } catch (error) {
        onToast?.(`删除失败：${String(error).replace(/^Error:\s*/, "")}`);
        return;
      }
      remove(p.id);
      onToast?.("已删除项目");
    }
  };

  return (
    <div className="project-page">
      {persistError && (
        <div className="project-persist-alert" role="alert">
          <span>项目已保存在本机缓存，但后端落盘失败：{persistError}</span>
          <button type="button" onClick={retryPersist} disabled={persisting}>
            {persisting ? "重试中…" : "重试"}
          </button>
        </div>
      )}
      <section className="project-hero">
        <div className="project-hero__text">
          <h1 className="project-hero__title">项目</h1>
          <p className="project-hero__subtitle">围绕目标组织上下文、对话与交付资产</p>
          <button type="button" className="project-hero__create" onClick={() => setCreate({})}>
            <AddIcon size="sm" />
            <span>新建项目</span>
          </button>
        </div>
        <img className="project-hero__art" src={heroImg} alt="项目工作台插画" draggable={false} />
      </section>

      <section className="project-section">
        <div className="project-section__head">
          <h3 className="project-section__title">我的项目</h3>
          <div className="project-search">
            <SearchIcon size="sm" className="project-search__icon" />
            <input
              type="text"
              className="project-search__input"
              placeholder="搜索项目"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        </div>
        {filtered.length === 0 ? (
          <div className="project-grid-empty">
            {projects.length === 0
              ? "还没有项目，点击「新建项目」或从下方模版创建。"
              : "没有匹配的项目。"}
          </div>
        ) : (
          <div className="project-grid">
            {filtered.map((p) => (
              <ProjectCard
                key={p.id}
                project={p}
                onEnter={() => setOpenId(p.id)}
                onStart={() => onStartProject?.(p)}
                onRename={() => handleRename(p)}
                onDelete={() => void handleDelete(p)}
              />
            ))}
          </div>
        )}
      </section>

      <section className="project-section">
        <div className="project-section__head">
          <h3 className="project-section__title">从模版创建</h3>
        </div>
        <div className="project-grid">
          {FROM_TEMPLATES.map((t) => (
            <button
              key={t.id}
              type="button"
              className="project-card2"
              onClick={() => setCreate({ templateId: t.id })}
            >
              <span className="project-card2__glyph">
                <ProjectGlyph />
              </span>
              <span className="project-card2__body">
                <span className="project-card2__name">{t.title}</span>
                <span className="project-card2__desc">{t.desc}</span>
              </span>
            </button>
          ))}
        </div>
      </section>

      {create && (
        <CreateProjectDialog
          preset={create}
          onCancel={() => setCreate(null)}
          onConfirm={(saved) => {
            setCreate(null);
            setOpenId(saved.id);
          }}
          cwd={cwd}
          picker={picker}
        />
      )}
    </div>
  );
}

// ============================================================
// Project Card
// ============================================================

function ProjectCard({
  project, onEnter, onStart, onRename, onDelete,
}: {
  project: ProjectMeta;
  onEnter: () => void;
  onStart: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuPosition, setMenuPosition] = useState<ProjectMenuPosition | null>(null);

  const closeMenu = useCallback((restoreFocus = false) => {
    setMenuOpen(false);
    setMenuPosition(null);
    if (restoreFocus) {
      window.requestAnimationFrame(() => triggerRef.current?.focus());
    }
  }, []);

  const updateMenuPosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;

    const rect = trigger.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    if (
      rect.bottom < 0 || rect.top > viewportHeight ||
      rect.right < 0 || rect.left > viewportWidth
    ) {
      closeMenu();
      return;
    }

    const measuredWidth = menuRef.current?.offsetWidth || PROJECT_MENU_ESTIMATED_WIDTH;
    // scrollHeight retains the full content height after maxHeight constrains
    // the visible box, so repositioning can expand the menu again later.
    const measuredHeight = menuRef.current?.scrollHeight
      || menuRef.current?.offsetHeight
      || PROJECT_MENU_ESTIMATED_HEIGHT;
    const menuWidth = Math.min(measuredWidth, Math.max(0, viewportWidth - PROJECT_MENU_MARGIN * 2));
    const spaceBelow = viewportHeight - rect.bottom - PROJECT_MENU_OFFSET - PROJECT_MENU_MARGIN;
    const spaceAbove = rect.top - PROJECT_MENU_OFFSET - PROJECT_MENU_MARGIN;
    const placement = spaceBelow >= measuredHeight || spaceBelow >= spaceAbove ? "bottom" : "top";
    const availableHeight = Math.max(0, placement === "bottom" ? spaceBelow : spaceAbove);
    const renderedHeight = Math.min(measuredHeight, availableHeight);
    const maxLeft = Math.max(PROJECT_MENU_MARGIN, viewportWidth - menuWidth - PROJECT_MENU_MARGIN);
    const left = Math.min(Math.max(PROJECT_MENU_MARGIN, rect.right - menuWidth), maxLeft);
    const desiredTop = placement === "bottom"
      ? rect.bottom + PROJECT_MENU_OFFSET
      : rect.top - PROJECT_MENU_OFFSET - renderedHeight;
    const maxTop = Math.max(PROJECT_MENU_MARGIN, viewportHeight - renderedHeight - PROJECT_MENU_MARGIN);
    const top = Math.min(Math.max(PROJECT_MENU_MARGIN, desiredTop), maxTop);

    setMenuPosition({ left, top, width: menuWidth, maxHeight: availableHeight, placement });
  }, [closeMenu]);

  useLayoutEffect(() => {
    if (!menuOpen) return;
    updateMenuPosition();
    const frame = window.requestAnimationFrame(updateMenuPosition);
    window.addEventListener("resize", updateMenuPosition);
    window.addEventListener("scroll", updateMenuPosition, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", updateMenuPosition);
      window.removeEventListener("scroll", updateMenuPosition, true);
    };
  }, [menuOpen, updateMenuPosition]);

  useEffect(() => {
    if (!menuOpen) return;
    const h = (e: MouseEvent) => {
      const target = e.target as Node;
      if (ref.current?.contains(target) || menuRef.current?.contains(target)) return;
      closeMenu();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeMenu(true);
    };
    document.addEventListener("mousedown", h);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", h);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen, closeMenu]);

  const menuStyle: CSSProperties = menuPosition
    ? {
        position: "fixed",
        left: menuPosition.left,
        top: menuPosition.top,
        width: menuPosition.width,
        minWidth: menuPosition.width,
        zIndex: PROJECT_MENU_Z_INDEX,
        maxHeight: menuPosition.maxHeight,
        overflowY: "auto",
      }
    : { position: "fixed", visibility: "hidden" };

  return (
    <div className="project-card2" ref={ref}>
      <div className="project-card2__main" onClick={onEnter}>
        <span className="project-card2__glyph"><ProjectGlyph /></span>
        <span className="project-card2__body">
          <span className="project-card2__name">{project.name}</span>
          <span className="project-card2__sub">{addedLabel(project.createdAt)}</span>
        </span>
      </div>
      <div className="project-card2__more-wrap">
        <button
          ref={triggerRef}
          type="button"
          className="project-card2__more"
          aria-label="更多操作"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={(e) => {
            e.stopPropagation();
            if (menuOpen) closeMenu();
            else setMenuOpen(true);
          }}
        >
          <MoreDotsIcon size="sm" />
        </button>
      </div>
      {menuOpen && typeof document !== "undefined" && createPortal(
        <div
          ref={menuRef}
          className="project-card2__menu"
          style={menuStyle}
          role="menu"
          aria-label={`${project.name} 操作菜单`}
          data-placement={menuPosition?.placement}
          onClick={(e) => e.stopPropagation()}
        >
          <button type="button" role="menuitem" className="project-card2__menu-item" onClick={() => { closeMenu(); onEnter(); }}>进入项目</button>
          <button type="button" role="menuitem" className="project-card2__menu-item" onClick={() => { closeMenu(); onStart(); }}>开始项目对话</button>
          <button type="button" role="menuitem" className="project-card2__menu-item" onClick={() => { closeMenu(); onRename(); }}>重命名</button>
          <div className="project-card2__menu-sep" role="separator" />
          <button type="button" role="menuitem" className="project-card2__menu-item project-card2__menu-item--danger" onClick={() => { closeMenu(); onDelete(); }}>删除</button>
        </div>,
        document.body,
      )}
    </div>
  );
}

// ============================================================
// Create Project Dialog (对齐目标截图)
// ============================================================

interface CreatePreset { templateId?: string }

function CreateProjectDialog({
  preset, onCancel, onConfirm, cwd, picker,
}: {
  preset: CreatePreset;
  onCancel: () => void;
  onConfirm: (saved: ProjectMeta) => void;
  cwd?: string;
  picker: { options: ProjectPickerOptions; loading: boolean; error: string | null };
}) {
  const add = useProjectsStore((s) => s.add);
  const initial = preset.templateId ? getTemplate(preset.templateId) : undefined;
  const [name, setName] = useState("");
  const [templateId, setTemplateId] = useState<string | undefined>(initial?.id);
  const [instructions, setInstructions] = useState(initial?.instructions ?? "");
  const [connectors, setConnectors] = useState<RefItem[]>(initial?.connectors ?? []);
  const [experts, setExperts] = useState<RefItem[]>(initial?.experts ?? []);
  const [skills, setSkills] = useState<RefItem[]>(initial?.skills ?? []);
  const [pickerFor, setPickerFor] = useState<null | "connectors" | "experts" | "skills">(null);
  const [tplOpen, setTplOpen] = useState(false);
  const tplRef = useOutsideClose<HTMLDivElement>(tplOpen, () => setTplOpen(false));

  const applyTemplate = (id: string) => {
    const t = getTemplate(id);
    setTemplateId(id);
    setInstructions(t?.instructions ?? "");
    setConnectors(t?.connectors ?? []);
    setExperts(t?.experts ?? []);
    setSkills(t?.skills ?? []);
    setTplOpen(false);
  };

  const currentTpl = getTemplate(templateId);

  const setPicked = (k: typeof pickerFor, items: RefItem[]) => {
    if (k === "connectors") setConnectors(items);
    else if (k === "experts") setExperts(items);
    else if (k === "skills") setSkills(items);
    setPickerFor(null);
  };

  const submit = () => {
    if (!name.trim()) return;
    const saved = add({
      name: name.trim(),
      cwd,
      templateId,
      instructions: instructions.trim() || undefined,
      connectors, experts, skills,
    });
    onConfirm(saved);
  };

  return (
    <div className="modal-overlay create-colleague-overlay" onClick={onCancel}>
      <div className="create-colleague-dialog create-project-dialog" onClick={(e) => e.stopPropagation()} role="dialog">
        <div className="create-colleague-header">
          <h3>新建项目</h3>
          <button className="create-colleague-close" onClick={onCancel} aria-label="关闭">×</button>
        </div>

        <div className="create-colleague-body">
          <div className="create-colleague-field">
            <label className="create-colleague-label">项目名称</label>
            <input
              type="text"
              className="create-colleague-input"
              value={name}
              maxLength={15}
              onChange={(e) => setName(e.target.value)}
              placeholder="请输入项目名称"
              autoFocus
            />
          </div>

          <div className="create-colleague-field">
            <div className="proj-field-head">
              <label className="create-colleague-label">指令</label>
              <div className="proj-tpl-select" ref={tplRef}>
                <button type="button" className="proj-tpl-select__btn" onClick={() => setTplOpen((v) => !v)}>
                  {currentTpl && currentTpl.id !== "custom" ? currentTpl.title : "选择模板"}
                  <ChevronDownIcon size="sm" />
                </button>
                {tplOpen && (
                  <div className="proj-tpl-select__menu">
                    {TEMPLATE_OPTIONS.map((t) => (
                      <button
                        key={t.id}
                        type="button"
                        className={`proj-tpl-select__item${t.id === templateId ? " proj-tpl-select__item--on" : ""}`}
                        onClick={() => applyTemplate(t.id)}
                      >
                        {t.title}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
            <textarea
              className="create-colleague-textarea"
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              rows={5}
              placeholder="提供当前项目的背景信息和规范，让 EchoAgent 的回复更精准、更符合要求。比如：项目目标、团队习惯、风格偏好、输出约束等"
            />
          </div>

          <ConfigRow label="连接器" items={connectors} onAdd={() => setPickerFor("connectors")} onRemove={(id) => setConnectors((p) => p.filter((x) => x.id !== id))} />
          <ConfigRow label="专家" items={experts} onAdd={() => setPickerFor("experts")} onRemove={(id) => setExperts((p) => p.filter((x) => x.id !== id))} />
          <ConfigRow label="技能" items={skills} onAdd={() => setPickerFor("skills")} onRemove={(id) => setSkills((p) => p.filter((x) => x.id !== id))} />
        </div>

        <div className="create-colleague-footer create-project-footer">
          <span className="proj-version-note">切换模版会覆盖当前编辑内容</span>
          <button className="btn btn--ghost" onClick={onCancel}>取消</button>
          <button className="btn btn--primary" onClick={submit} disabled={!name.trim()}>确定</button>
        </div>
      </div>

      {pickerFor && (
        <RefPickerDialog
          title={pickerFor === "connectors" ? "连接器" : pickerFor === "experts" ? "专家" : "技能"}
          options={picker.options[pickerFor]}
          emptyHint={picker.loading ? "正在读取运行时能力…" : picker.error ? `读取失败：${picker.error}` : `当前没有已启用的${pickerFor === "connectors" ? "连接器" : pickerFor === "experts" ? "Agent" : "Skill"}`}
          selected={pickerFor === "connectors" ? connectors : pickerFor === "experts" ? experts : skills}
          onCancel={() => setPickerFor(null)}
          onConfirm={(items) => setPicked(pickerFor, items)}
        />
      )}
    </div>
  );
}

// ============================================================
// Glyph + helpers
// ============================================================

function ProjectGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden="true">
      <circle cx="6" cy="7" r="2.2" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="18" cy="7" r="2.2" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="12" cy="17.5" r="2.2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M7.7 8.4 10.5 15.6M16.3 8.4 13.5 15.6M8 7h8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function addedLabel(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const days = Math.floor((Date.now() - t) / 86_400_000);
  if (days <= 0) return "添加于 今天";
  return `添加于 ${days} 天前`;
}
