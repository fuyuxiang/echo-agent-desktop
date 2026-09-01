/**
 * 项目详情页 — 对齐目标截图（图3-6）。
 *
 *  布局: 顶部面包屑(📁 项目 / 名) + 右上「邀请」 + tab 栏(动态/计划/任务/资产)
 *        + 右侧「项目配置」栏(指令/连接器/专家/技能/自动化) + 底部项目级 Composer。
 *  项目元数据由 Rust 数据文件持久；计划/任务可编辑，资产是已复制
 *  到项目私有目录的真实文件，专家/技能/MCP 选项来自当前运行时。
 */
import { useState } from "react";
import {
  useProjectsStore,
  type ProjectMeta,
  type RefItem,
} from "@/stores/projects-store";
import {
  ConfigRow,
  RefPickerDialog,
  type ProjectPickerOptions,
} from "./project-picker";
import { ActivityTab, PlanTab, TaskTab, AssetsTab } from "./project-tabs";
import { FolderIcon } from "@/foundation/components/Icon/icons";

type TabKey = "activity" | "plan" | "task" | "asset";
type DrawerKey = "instruction" | "connectors" | "experts" | "skills" | "automation";

const TABS: { key: TabKey; label: string }[] = [
  { key: "activity", label: "动态" },
  { key: "plan", label: "计划" },
  { key: "task", label: "任务" },
  { key: "asset", label: "资产" },
];

const CONFIG_CARDS: { key: DrawerKey; title: string; desc: string }[] = [
  { key: "instruction", title: "指令", desc: "设定项目背景与规范，让 AI 与你高效协作" },
  { key: "connectors", title: "连接器", desc: "连接外部服务，扩展 AI 能力" },
  { key: "experts", title: "专家", desc: "配置项目专家，为成员提供更专业的服务" },
  { key: "skills", title: "技能", desc: "配置项目技能，让 AI 精准执行任务" },
  { key: "automation", title: "自动化", desc: "让 AI 按计划自动执行任务" },
];

export function ProjectDetailView({
  project,
  onBack,
  onToast,
  onStartConversation,
  onOpenSession,
  picker,
  onOpenAutomation,
}: {
  project: ProjectMeta;
  onBack: () => void;
  onToast?: (msg: string) => void;
  /** Start a new conversation within this project (creates a real EchoAgent session). */
  onStartConversation?: (projectId: string, message: string) => Promise<string | undefined>;
  onOpenSession?: (sessionId: string, cwd?: string) => void;
  picker: { options: ProjectPickerOptions; loading: boolean; error: string | null };
  onOpenAutomation?: () => void;
}) {
  // 读最新（交互后 store 更新，父传入的快照可能过期）。
  const live = useProjectsStore((s) => s.projects.find((p) => p.id === project.id)) ?? project;
  const updateConfig = useProjectsStore((s) => s.updateConfig);
  const addMember = useProjectsStore((s) => s.addMember);

  const [tab, setTab] = useState<TabKey>("activity");
  const [drawer, setDrawer] = useState<DrawerKey | null>(null);
  const [membersOpen, setMembersOpen] = useState(false);
  const [pickerFor, setPickerFor] = useState<null | "connectors" | "experts" | "skills">(null);

  const setPicked = (k: typeof pickerFor, items: RefItem[]) => {
    if (!k) return;
    if (k === "connectors") updateConfig(live.id, { connectors: items });
    else if (k === "experts") updateConfig(live.id, { experts: items });
    else updateConfig(live.id, { skills: items });
    setPickerFor(null);
  };

  const invite = () => {
    const name = window.prompt("添加参与者备注（姓名或角色）");
    if (name && name.trim()) {
      addMember(live.id, name.trim());
      onToast?.(`已添加参与者备注：${name.trim()}`);
      setMembersOpen(false);
    }
  };

  const handleComposerSend = (text: string) => {
    if (onStartConversation) {
      void onStartConversation(live.id, text);
    } else {
      const preview = text.slice(0, 20);
      const suffix = text.length > 20 ? "…" : "";
      onToast?.(`无法启动项目会话：${preview}${suffix}`);
    }
  };

  return (
    <div className="pd-page">
      <header className="pd-topbar">
        <div className="pd-crumb">
          <FolderIcon size="sm" />
          <button className="pd-crumb__link" onClick={onBack}>项目</button>
          <span className="pd-crumb__sep">/</span>
          <span className="pd-crumb__name">{live.name}</span>
        </div>
        <div className="pd-topbar__right">
          <button className="pd-invite" onClick={() => setMembersOpen((v) => !v)}>参与者</button>
          {membersOpen && (
            <div className="pd-members-pop">
              <div className="pd-members-pop__head">项目参与者（本机备注）</div>
              {live.members.length === 0 ? (
                <div className="pd-members-pop__empty">暂无成员</div>
              ) : (
                live.members.map((m) => (
                  <div className="pd-members-pop__item" key={m}>{m}</div>
                ))
              )}
              <button className="pd-members-pop__add" onClick={invite}>+ 添加参与者</button>
            </div>
          )}
        </div>
      </header>

      <div className="pd-body">
        <div className="pd-main">
          <div className="pd-tabs-row">
            <nav className="pd-tabs">
              {TABS.map((t) => (
                <button
                  key={t.key}
                  className={`pd-tab-btn${tab === t.key ? " pd-tab-btn--on" : ""}`}
                  onClick={() => setTab(t.key)}
                >
                  {t.label}
                </button>
              ))}
            </nav>
          </div>

          <div className="pd-tab-content">
            {tab === "activity" && <ActivityTab projectId={live.id} onOpenSession={onOpenSession} />}
            {tab === "plan" && <PlanTab projectId={live.id} onRun={onStartConversation ? (message) => onStartConversation(live.id, message) : undefined} onOpenSession={onOpenSession ? (sessionId) => onOpenSession(sessionId, live.cwd) : undefined} />}
            {tab === "task" && <TaskTab projectId={live.id} onRun={onStartConversation ? (message) => onStartConversation(live.id, message) : undefined} onOpenSession={onOpenSession ? (sessionId) => onOpenSession(sessionId, live.cwd) : undefined} />}
            {tab === "asset" && <AssetsTab projectId={live.id} onToast={onToast} />}
          </div>

          <ProjectComposer project={live} onSend={handleComposerSend} />
        </div>

        <aside className="pd-side">
          <h3 className="pd-side__title">项目配置</h3>
          {CONFIG_CARDS.map((c) => (
            <button key={c.key} className="pd-config-card" onClick={() => setDrawer(c.key)}>
              <div className="pd-config-card__head">
                <span className="pd-config-card__title">{c.title}</span>
                <span className="pd-config-card__plus">+</span>
              </div>
              <div className="pd-config-card__desc">{c.desc}</div>
            </button>
          ))}
        </aside>
      </div>

      {drawer && (
        <ConfigDrawer
          drawer={drawer}
          project={live}
          onClose={() => setDrawer(null)}
          onOpenPicker={(k) => setPickerFor(k)}
          onOpenAutomation={onOpenAutomation}
        />
      )}

      {pickerFor && (
        <RefPickerDialog
          title={pickerFor === "connectors" ? "连接器" : pickerFor === "experts" ? "专家" : "技能"}
          options={picker.options[pickerFor]}
          emptyHint={picker.loading ? "正在读取运行时能力…" : picker.error ? `读取失败：${picker.error}` : "当前没有已启用的可选项"}
          selected={pickerFor === "connectors" ? live.connectors : pickerFor === "experts" ? live.experts : live.skills}
          onCancel={() => setPickerFor(null)}
          onConfirm={(items) => setPicked(pickerFor, items)}
        />
      )}
    </div>
  );
}

// ============================================================
// 配置抽屉
// ============================================================

function ConfigDrawer({
  drawer, project, onClose, onOpenPicker, onOpenAutomation,
}: {
  drawer: DrawerKey;
  project: ProjectMeta;
  onClose: () => void;
  onOpenPicker: (k: "connectors" | "experts" | "skills") => void;
  onOpenAutomation?: () => void;
}) {
  const updateConfig = useProjectsStore((s) => s.updateConfig);
  const card = CONFIG_CARDS.find((c) => c.key === drawer)!;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="create-colleague-dialog proj-drawer" onClick={(e) => e.stopPropagation()} role="dialog">
        <div className="create-colleague-header">
          <h3>{card.title}</h3>
          <button className="create-colleague-close" onClick={onClose} aria-label="关闭">×</button>
        </div>
        <div className="create-colleague-body">
          {drawer === "instruction" && (
            <textarea
              className="create-colleague-textarea"
              rows={8}
              value={project.instructions ?? ""}
              onChange={(e) => updateConfig(project.id, { instructions: e.target.value })}
              placeholder="设定项目背景与规范，让 AI 与你高效协作…"
              autoFocus
            />
          )}
          {drawer === "connectors" && (
            <ConfigRow label="连接器" items={project.connectors} onAdd={() => onOpenPicker("connectors")} onRemove={(id) => updateConfig(project.id, { connectors: project.connectors.filter((x) => x.id !== id) })} />
          )}
          {drawer === "experts" && (
            <ConfigRow label="专家" items={project.experts} onAdd={() => onOpenPicker("experts")} onRemove={(id) => updateConfig(project.id, { experts: project.experts.filter((x) => x.id !== id) })} />
          )}
          {drawer === "skills" && (
            <ConfigRow label="技能" items={project.skills} onAdd={() => onOpenPicker("skills")} onRemove={(id) => updateConfig(project.id, { skills: project.skills.filter((x) => x.id !== id) })} />
          )}
          {drawer === "automation" && (
            <div className="proj-drawer-empty">
              <p>自动化在统一调度中心配置，可选择本项目目录作为运行工作区。</p>
              <button className="btn btn--ghost" onClick={() => { onClose(); onOpenAutomation?.(); }}>打开自动化中心</button>
            </div>
          )}
        </div>
        <div className="create-colleague-footer">
          <button className="btn btn--primary" onClick={onClose}>完成</button>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// 项目级 Composer 薄壳（左 Craft/Auto/技能/连接器 + 右 +/发送）
// ============================================================

function ProjectComposer({ project, onSend }: { project: ProjectMeta; onSend: (text: string) => void }) {
  const [text, setText] = useState("");
  const send = () => {
    const t = text.trim();
    if (!t) return;
    onSend(t);
    setText("");
  };
  return (
    <div className="pd-composer">
      <textarea
        className="pd-composer__input"
        rows={1}
        value={text}
        placeholder="输入消息..."
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            send();
          }
        }}
      />
      <div className="pd-composer__footer">
        <span className="pd-composer__context" title="项目指令和所选能力偏好将注入新会话；实际可用性以当前运行时为准">
          项目上下文将注入
          {project.experts.length > 0 ? ` · ${project.experts.length} Agent` : ""}
          {project.skills.length > 0 ? ` · ${project.skills.length} Skill` : ""}
          {project.connectors.length > 0 ? ` · ${project.connectors.length} MCP` : ""}
        </span>
        <span className="pd-composer__spacer" />
        <button className="pd-composer__send" onClick={send} aria-label="发送" disabled={!text.trim()}>➤</button>
      </div>
    </div>
  );
}
