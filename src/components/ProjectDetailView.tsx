/**
 * 项目详情页 — 对齐目标截图（图3-6）。
 *
 *  布局: 顶部面包屑(📁 项目 / 名) + 右上「邀请」 + tab 栏(动态/计划/任务/资产)
 *        + 右侧「项目配置」栏(指令/连接器/专家/技能/自动化) + 底部项目级 Composer。
 *  项目元数据由 Rust 数据文件持久；计划/任务可编辑，资产是已复制
 *  到项目私有目录的真实文件，专家/技能/MCP 选项来自当前运行时。
 */
import { useCallback, useEffect, useState } from "react";
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
import { ModelSelector, type ModelOption } from "./ModelSelector";
import { FolderIcon } from "@/foundation/components/Icon/icons";
import { useModalFocus } from "@/lib/use-modal-focus";
import { useAppDialog } from "./AppDialog";

type TabKey = "activity" | "plan" | "task" | "asset";
type DrawerKey = "instruction" | "model" | "connectors" | "experts" | "skills" | "automation";

const TABS: { key: TabKey; label: string }[] = [
  { key: "activity", label: "动态" },
  { key: "plan", label: "计划" },
  { key: "task", label: "任务" },
  { key: "asset", label: "资产" },
];

const CONFIG_CARDS: { key: DrawerKey; title: string; desc: string }[] = [
  { key: "instruction", title: "指令", desc: "设定项目背景与规范，让 AI 与你高效协作" },
  { key: "model", title: "模型", desc: "选择项目对话和任务默认使用的模型" },
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
  onRenameSession,
  onArchiveSession,
  onDeleteSession,
  picker,
  onOpenAutomation,
  models = [],
  defaultModelId,
  onOpenModelSettings,
}: {
  project: ProjectMeta;
  onBack: () => void;
  onToast?: (msg: string) => void;
  /** Start a new conversation within this project (creates a real EchoAgent session). */
  onStartConversation?: (projectId: string, message: string, modelId: string) => Promise<string | undefined>;
  onOpenSession?: (sessionId: string, cwd?: string) => void;
  onRenameSession?: (sessionId: string, title: string, cwd?: string) => Promise<void>;
  onArchiveSession?: (sessionId: string, archived: boolean, cwd?: string) => Promise<void>;
  onDeleteSession?: (sessionId: string, cwd?: string) => Promise<void>;
  picker: { options: ProjectPickerOptions; loading: boolean; error: string | null };
  onOpenAutomation?: () => void;
  models?: ModelOption[];
  /** Application default, used only by projects that do not yet have a persisted choice. */
  defaultModelId?: string;
  onOpenModelSettings?: () => void;
}) {
  // 读最新（交互后 store 更新，父传入的快照可能过期）。
  const live = useProjectsStore((s) => s.projects.find((p) => p.id === project.id)) ?? project;
  const updateConfig = useProjectsStore((s) => s.updateConfig);
  const addMember = useProjectsStore((s) => s.addMember);

  const [tab, setTab] = useState<TabKey>("activity");
  const [drawer, setDrawer] = useState<DrawerKey | null>(null);
  const [membersOpen, setMembersOpen] = useState(false);
  const [pickerFor, setPickerFor] = useState<null | "connectors" | "experts" | "skills">(null);
  const { requestInput, dialog } = useAppDialog(live.id);
  const configuredProjectModelAvailable = !live.defaultModelId
    || models.some((model) => model.id === live.defaultModelId);
  const inheritedModelId = defaultModelId && models.some((model) => model.id === defaultModelId)
    ? defaultModelId
    : models[0]?.id;
  const projectModelId = live.defaultModelId
    ? configuredProjectModelAvailable ? live.defaultModelId : undefined
    : inheritedModelId;
  const setProjectModel = (modelId: string) => {
    updateConfig(live.id, { defaultModelId: modelId });
  };

  const setPicked = (k: typeof pickerFor, items: RefItem[]) => {
    if (!k) return;
    if (k === "connectors") updateConfig(live.id, { connectors: items });
    else if (k === "experts") updateConfig(live.id, { experts: items });
    else updateConfig(live.id, { skills: items });
    setPickerFor(null);
  };

  const invite = () => {
    requestInput({
      title: "添加参与者备注",
      description: "可以填写姓名、职责或角色。该备注仅保存在本机项目中。",
      fields: [{ name: "name", label: "姓名或角色", required: true, maxLength: 100 }],
      confirmLabel: "添加",
      action: ({ name }) => {
        const trimmed = name.trim();
        addMember(live.id, trimmed);
        onToast?.(`已添加参与者备注：${trimmed}`);
        setMembersOpen(false);
      },
    });
  };

  const handleComposerSend = async (text: string, modelId: string): Promise<boolean> => {
    if (onStartConversation) {
      // Legacy projects can inherit the application default for display, but
      // the first actual run materializes it so future execution is stable.
      if (live.defaultModelId !== modelId) setProjectModel(modelId);
      return Boolean(await onStartConversation(live.id, text, modelId));
    } else {
      const preview = text.slice(0, 20);
      const suffix = text.length > 20 ? "…" : "";
      onToast?.(`无法启动项目会话：${preview}${suffix}`);
      return false;
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
            {tab === "activity" && (
              <ActivityTab
                projectId={live.id}
                onOpenSession={onOpenSession}
                onRenameSession={onRenameSession}
                onArchiveSession={onArchiveSession}
                onDeleteSession={onDeleteSession}
                onToast={onToast}
                models={models}
              />
            )}
            {tab === "plan" && (
              <PlanTab
                projectId={live.id}
                models={models}
                defaultModelId={projectModelId}
                onRun={onStartConversation
                  ? (message, modelId) => onStartConversation(live.id, message, modelId)
                  : undefined}
                onOpenSession={onOpenSession ? (sessionId) => onOpenSession(sessionId, live.cwd) : undefined}
                onToast={onToast}
              />
            )}
            {tab === "task" && (
              <TaskTab
                projectId={live.id}
                models={models}
                defaultModelId={projectModelId}
                onRun={onStartConversation
                  ? (message, modelId) => onStartConversation(live.id, message, modelId)
                  : undefined}
                onOpenSession={onOpenSession ? (sessionId) => onOpenSession(sessionId, live.cwd) : undefined}
                onToast={onToast}
              />
            )}
            {tab === "asset" && <AssetsTab projectId={live.id} onToast={onToast} />}
          </div>

          <ProjectComposer
            project={live}
            models={models}
            modelId={projectModelId}
            unavailableModelId={configuredProjectModelAvailable ? undefined : live.defaultModelId}
            onModelChange={setProjectModel}
            onOpenModelSettings={onOpenModelSettings}
            onSend={handleComposerSend}
          />
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
          models={models}
          modelId={projectModelId}
          unavailableModelId={configuredProjectModelAvailable ? undefined : live.defaultModelId}
          onModelChange={setProjectModel}
          onOpenModelSettings={onOpenModelSettings}
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
      {dialog}
    </div>
  );
}

// ============================================================
// 配置抽屉
// ============================================================

function ConfigDrawer({
  drawer,
  project,
  onClose,
  onOpenPicker,
  onOpenAutomation,
  models,
  modelId,
  unavailableModelId,
  onModelChange,
  onOpenModelSettings,
}: {
  drawer: DrawerKey;
  project: ProjectMeta;
  onClose: () => void;
  onOpenPicker: (k: "connectors" | "experts" | "skills") => void;
  onOpenAutomation?: () => void;
  models: ModelOption[];
  modelId?: string;
  unavailableModelId?: string;
  onModelChange: (modelId: string) => void;
  onOpenModelSettings?: () => void;
}) {
  const updateConfig = useProjectsStore((s) => s.updateConfig);
  const card = CONFIG_CARDS.find((c) => c.key === drawer)!;
  const [instructionDraft, setInstructionDraft] = useState(project.instructions ?? "");
  useEffect(() => {
    setInstructionDraft(project.instructions ?? "");
  }, [project.id, project.instructions]);
  const closeDrawer = useCallback(() => {
    if (drawer === "instruction" && instructionDraft !== (project.instructions ?? "")) {
      updateConfig(project.id, { instructions: instructionDraft });
    }
    onClose();
  }, [drawer, instructionDraft, onClose, project.id, project.instructions, updateConfig]);
  const dialogRef = useModalFocus<HTMLDivElement>(true, closeDrawer);

  return (
    <div className="modal-overlay" onClick={closeDrawer}>
      <div
        ref={dialogRef}
        className="create-colleague-dialog proj-drawer"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`项目配置：${card.title}`}
        tabIndex={-1}
      >
        <div className="create-colleague-header">
          <h3>{card.title}</h3>
          <button
            className="create-colleague-close"
            onClick={closeDrawer}
            aria-label="关闭"
            data-modal-initial-focus={drawer === "instruction" ? undefined : ""}
          >×</button>
        </div>
        <div className="create-colleague-body">
          {drawer === "instruction" && (
            <textarea
              className="create-colleague-textarea"
              rows={8}
              value={instructionDraft}
              maxLength={128_000}
              onChange={(e) => setInstructionDraft(e.target.value)}
              placeholder="设定项目背景与规范，让 AI 与你高效协作…"
              data-modal-initial-focus
            />
          )}
          {drawer === "model" && (
            <div className="proj-model-setting">
              <label className="create-colleague-label">项目默认模型</label>
              <p className="proj-model-setting__hint">
                新对话、新计划和新任务默认使用此模型；执行前仍可为单条计划或任务单独选择。
              </p>
              <ModelSelector
                ariaLabel="选择项目默认模型"
                modelId={modelId}
                models={models}
                onModelChange={onModelChange}
              />
              {unavailableModelId && (
                <p className="proj-model-setting__warning" role="alert">
                  原模型“{unavailableModelId}”已被删除或停用，请重新选择。
                </p>
              )}
              {models.length === 0 && (
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => {
                    closeDrawer();
                    onOpenModelSettings?.();
                  }}
                >
                  前往设置模型
                </button>
              )}
            </div>
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
              <button className="btn btn--ghost" onClick={() => { closeDrawer(); onOpenAutomation?.(); }}>打开自动化中心</button>
            </div>
          )}
        </div>
        <div className="create-colleague-footer">
          <button className="btn btn--primary" onClick={closeDrawer}>完成</button>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// 项目级 Composer 薄壳（左 Craft/Auto/技能/连接器 + 右 +/发送）
// ============================================================

function ProjectComposer({
  project,
  models,
  modelId,
  unavailableModelId,
  onModelChange,
  onOpenModelSettings,
  onSend,
}: {
  project: ProjectMeta;
  models: ModelOption[];
  modelId?: string;
  unavailableModelId?: string;
  onModelChange: (modelId: string) => void;
  onOpenModelSettings?: () => void;
  onSend: (text: string, modelId: string) => Promise<boolean>;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const send = async () => {
    const t = text.trim();
    if (!t || !modelId || sending) return;
    setSending(true);
    setSendError(null);
    try {
      const sent = await onSend(t, modelId);
      if (sent) setText("");
      else setSendError("消息尚未发送，请完成模型配置或检查当前配额后重试。");
    } catch (error) {
      setSendError(`发送失败：${String(error).replace(/^Error:\s*/, "")}`);
    } finally {
      setSending(false);
    }
  };
  return (
    <div className="pd-composer">
      <textarea
        className="pd-composer__input"
        rows={1}
        value={text}
        placeholder="输入消息..."
        disabled={sending}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void send();
          }
        }}
      />
      {sendError && <div className="pd-composer__error" role="alert">{sendError}</div>}
      {!modelId && (
        <div className="pd-composer__error pd-composer__model-warning" role="alert">
          {unavailableModelId
            ? `原项目模型“${unavailableModelId}”已不可用，请重新选择。`
            : "发送前需要选择一个执行模型。"}
          {models.length === 0 && onOpenModelSettings && (
            <button type="button" onClick={onOpenModelSettings}>前往设置模型</button>
          )}
        </div>
      )}
      <div className="pd-composer__footer">
        <span className="pd-composer__context" title="项目指令和所选能力偏好将注入新会话；实际可用性以当前运行时为准">
          项目上下文将注入
          {project.experts.length > 0 ? ` · ${project.experts.length} Agent` : ""}
          {project.skills.length > 0 ? ` · ${project.skills.length} Skill` : ""}
          {project.connectors.length > 0 ? ` · ${project.connectors.length} MCP` : ""}
        </span>
        <span className="pd-composer__spacer" />
        <ModelSelector
          ariaLabel="选择项目对话模型"
          modelId={modelId}
          models={models}
          disabled={sending}
          onModelChange={onModelChange}
        />
        <button
          className="pd-composer__send"
          onClick={() => void send()}
          aria-label="发送"
          disabled={!text.trim() || !modelId || sending}
          title={!modelId ? "请先选择可用模型" : undefined}
        >
          {sending ? "…" : "➤"}
        </button>
      </div>
    </div>
  );
}
