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
import { Composer } from "./Composer";
import { ModelSelector, type ModelOption } from "./ModelSelector";
import { FolderIcon } from "@/foundation/components/Icon/icons";
import { useModalFocus } from "@/lib/use-modal-focus";
import { useAppDialog } from "./AppDialog";
import type { AgentEntry } from "@/lib/types";
import type { SlashCommandInvocation } from "@/lib/slash-commands";
import { useWorkspaceMentions } from "@/lib/use-workspace-mentions";

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
  onClientSlashCommand,
  onNavigateConnectors,
  onOpenKnowledgeBase,
  onOpenOrganization,
}: {
  project: ProjectMeta;
  onBack: () => void;
  onToast?: (msg: string) => void;
  /** Start a new conversation within this project (creates a real EchoAgent session). */
  onStartConversation?: (
    projectId: string,
    message: string,
    modelId: string,
    attachments?: string[],
  ) => Promise<string | undefined>;
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
  onClientSlashCommand?: (invocation: SlashCommandInvocation) => boolean | void | Promise<boolean | void>;
  onNavigateConnectors?: () => void;
  onOpenKnowledgeBase?: () => void;
  onOpenOrganization?: () => void;
}) {
  // 读最新（交互后 store 更新，父传入的快照可能过期）。
  const live = useProjectsStore((s) => s.projects.find((p) => p.id === project.id)) ?? project;
  const updateConfig = useProjectsStore((s) => s.updateConfig);
  const addMember = useProjectsStore((s) => s.addMember);

  const [tab, setTab] = useState<TabKey>("activity");
  const [drawer, setDrawer] = useState<DrawerKey | null>(null);
  const [membersOpen, setMembersOpen] = useState(false);
  const [pickerFor, setPickerFor] = useState<null | "connectors" | "experts" | "skills">(null);
  // Composer 失败原因。Composer 内部不持有"失败 alert",必须由调用方展示,
  // 否则用户看到"按了发送但什么都没发生"。
  const [sendError, setSendError] = useState<string | null>(null);
  const [composerExpert, setComposerExpert] = useState<AgentEntry | null>(null);
  const { requestInput, dialog } = useAppDialog(live.id);
  const mentionCandidates = useWorkspaceMentions(live.cwd);
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

  const addComposerExpert = (agent: AgentEntry) => {
    const item: RefItem = {
      id: agent.path || agent.name,
      name: agent.name,
    };
    if (!live.experts.some((expert) => expert.id === item.id || expert.name === item.name)) {
      updateConfig(live.id, { experts: [...live.experts, item] });
    }
    setComposerExpert(agent);
    onToast?.(`已将专家「${agent.name}」加入项目上下文`);
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

  const handleComposerSend = async (
    text: string,
    modelId: string,
    attachments: string[] = [],
  ): Promise<boolean> => {
    if (!onStartConversation) {
      const preview = text.slice(0, 20);
      const suffix = text.length > 20 ? "…" : "";
      onToast?.(`无法启动项目会话：${preview}${suffix}`);
      return false;
    }
    // Legacy projects can inherit the application default for display, but
    // the first actual run materializes it so future execution is stable.
    if (live.defaultModelId !== modelId) setProjectModel(modelId);
    setSendError(null);
    try {
      const sessionId = await onStartConversation(live.id, text, modelId, attachments);
      if (sessionId) return true;
      setSendError("消息尚未发送，请完成模型配置或检查当前配额后重试。");
      return false;
    } catch (error) {
      setSendError(`发送失败：${String(error).replace(/^Error:\s*/, "")}`);
      return false;
    }
  };

  // header chip 文案：项目契约注入摘要。0 项降级为「仅指令」（含项目说明）
  // 或「无」；指令是项目核心契约，即使无 Agent/Skill/MCP 也应显示。
  const hasInstructionsOnly = live.experts.length === 0
    && live.skills.length === 0
    && live.connectors.length === 0
    && typeof live.instructions === "string"
    && live.instructions.trim().length > 0;
  const hasNoContract = live.experts.length === 0
    && live.skills.length === 0
    && live.connectors.length === 0
    && !hasInstructionsOnly;
  const projectHeaderAria = hasInstructionsOnly
    ? `项目「${live.name}」当前会话将注入项目指令`
    : hasNoContract
      ? `项目「${live.name}」当前会话未配置任何 Agent、Skill 或 MCP`
      : `项目「${live.name}」当前会话将注入 ${live.experts.length} 个 Agent、${live.skills.length} 个 Skill、${live.connectors.length} 个 MCP`;

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
                  ? (message, modelId) => onStartConversation(live.id, message, modelId, [])
                  : undefined}
                onOpenSession={onOpenSession ? (sessionId) => onOpenSession(sessionId, live.cwd) : undefined}
                onRestoreSession={onArchiveSession
                  ? (sessionId) => onArchiveSession(sessionId, false, live.cwd)
                  : undefined}
                onToast={onToast}
              />
            )}
            {tab === "task" && (
              <TaskTab
                projectId={live.id}
                models={models}
                defaultModelId={projectModelId}
                onRun={onStartConversation
                  ? (message, modelId) => onStartConversation(live.id, message, modelId, [])
                  : undefined}
                onOpenSession={onOpenSession ? (sessionId) => onOpenSession(sessionId, live.cwd) : undefined}
                onRestoreSession={onArchiveSession
                  ? (sessionId) => onArchiveSession(sessionId, false, live.cwd)
                  : undefined}
                onToast={onToast}
              />
            )}
            {tab === "asset" && <AssetsTab projectId={live.id} onToast={onToast} />}
          </div>

          <div className="pd-composer-shell">
            <div
              className="pd-composer-header"
              role="status"
              aria-label={projectHeaderAria}
              title={projectHeaderAria}
            >
              <span className="pd-composer-header__icon" aria-hidden="true">
                <FolderIcon size="xs" />
              </span>
              <span className="pd-composer-header__name">{live.name}</span>
              <span className="pd-composer-header__sep" aria-hidden="true">·</span>
              <span className="pd-composer-header__label">注入：</span>
              {hasInstructionsOnly ? (
                <span className="pd-composer-header__count pd-composer-header__count--active">仅指令</span>
              ) : hasNoContract ? (
                <span className="pd-composer-header__count">无</span>
              ) : (
                <>
                  <span className={`pd-composer-header__count${live.experts.length > 0 ? " pd-composer-header__count--active" : ""}`}>
                    {live.experts.length} Agent
                  </span>
                  <span className="pd-composer-header__sep" aria-hidden="true">·</span>
                  <span className={`pd-composer-header__count${live.skills.length > 0 ? " pd-composer-header__count--active" : ""}`}>
                    {live.skills.length} Skill
                  </span>
                  <span className="pd-composer-header__sep" aria-hidden="true">·</span>
                  <span className={`pd-composer-header__count${live.connectors.length > 0 ? " pd-composer-header__count--active" : ""}`}>
                    {live.connectors.length} MCP
                  </span>
                </>
              )}
            </div>
            <Composer
              streaming={false}
              onSend={(text, attachments) => handleComposerSend(text, projectModelId!, attachments)}
              onCancel={() => { /* 项目页 composer 不流式,onCancel 为 Composer prop 必传的占位。 */ }}
              placeholder="输入项目任务或附件（Shift+Enter 换行）"
              apiReady={!!projectModelId && models.length > 0}
              setupHint={
                models.length === 0
                  ? "请先在「设置 → 模型」配置模型"
                  : !projectModelId && live.defaultModelId
                    ? `原项目模型「${live.defaultModelId}」已不可用，请重新选择`
                    : undefined
              }
              onOpenSettings={onOpenModelSettings}
              onToast={onToast}
              modelId={projectModelId}
              modelLoading={false}
              models={models}
              onModelChange={setProjectModel}
              cwd={live.cwd}
              onSelectExpert={addComposerExpert}
              activeExpertName={composerExpert?.name}
              onDismissExpert={() => setComposerExpert(null)}
              onNavigateConnectors={onNavigateConnectors}
              onOpenKnowledgeBase={onOpenKnowledgeBase}
              onOpenOrganization={onOpenOrganization}
              onClientSlashCommand={onClientSlashCommand}
              filePaths={mentionCandidates.filePaths}
              workspaceSymbols={mentionCandidates.workspaceSymbols}
            />
            {(sendError || (!projectModelId && live.defaultModelId)) && (
              <div className="pd-composer-warning" role="alert">
                <span>
                  {sendError
                    ?? `原项目模型「${live.defaultModelId}」已不可用，请重新选择。`}
                </span>
                {models.length === 0 && onOpenModelSettings && (
                  <button type="button" onClick={onOpenModelSettings}>
                    前往设置模型
                  </button>
                )}
              </div>
            )}
          </div>
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
// 项目 composer 改用首页 `<Composer>`（src/components/Composer.tsx），
// 原薄壳函数 ProjectComposer 已删除：附件 / 拖拽 / `/` / `@` / 语音 /
// 输入历史 / 知识来源 等能力统一由 Composer 接管；项目级契约（cwd +
// 上下文注入摘要）通过 header chip 与 Composer 的 props 表达。
// ============================================================
