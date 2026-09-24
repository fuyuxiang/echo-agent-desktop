import { useEffect, useRef, useState } from "react";
import { Composer } from "./Composer";
import type { ModelOption } from "./ModelSelector";
import type { WorkspaceInfo } from "@/lib/agent-client";
import type { AgentEntry } from "@/lib/types";
import { useSessionsStore, HOME_DRAFT_KEY } from "@/stores/sessions-store";
import { usePendingExpertStore } from "@/stores/pending-expert-store";
import type { SlashCommandInvocation } from "@/lib/slash-commands";
import { useWorkspaceMentions } from "@/lib/use-workspace-mentions";
import type { AutomationMode } from "@/lib/automation-client";
import { CheckCircle2, FolderOpen, KeyRound, Cpu } from "lucide-react";

/** EchoAgent 首页：单一任务入口。 */
export function HomePage({
  onSend,
  streaming,
  apiReady,
  setupHint,
  creatingSession,
  sendError,
  onOpenSettings,
  onPlaceholder,
  modelId,
  models,
  onModelChange,
  cwd,
  workspaces,
  onSelectWorkspace,
  onSelectExpert,
  onNavigateConnectors,
  onOpenKnowledgeBase,
  onOpenMeetingMinutes,
  onOpenOrganization,
  commandRefreshKey,
  onClientSlashCommand,
  taskMode,
  onTaskModeChange,
}: {
  onSend: (text: string, attachments?: string[]) => boolean | void | Promise<boolean | void>;
  streaming: boolean;
  apiReady: boolean;
  setupHint?: string;
  creatingSession?: boolean;
  sendError?: string | null;
  onOpenSettings: () => void;
  onPlaceholder: (label: string) => void;
  modelId?: string;
  models?: ModelOption[];
  onModelChange?: (id: string) => void;
  cwd?: string;
  workspaces?: WorkspaceInfo[];
  onSelectWorkspace?: (cwd: string) => void;
  onSelectExpert?: (agent: AgentEntry) => void;
  onNavigateConnectors?: () => void;
  onOpenKnowledgeBase?: () => void;
  onOpenMeetingMinutes?: () => void;
  onOpenOrganization?: () => void;
  commandRefreshKey?: number;
  onClientSlashCommand?: (
    invocation: SlashCommandInvocation,
  ) => boolean | void | Promise<boolean | void>;
  taskMode?: AutomationMode;
  onTaskModeChange?: (mode: AutomationMode) => void;
}) {
  // 受控填充 Composer 的内容 + nonce（召唤专家后写入 quick prompt）。
  const [externalText, setExternalText] = useState("");
  const [externalTextNonce, setExternalTextNonce] = useState(0);
  // 首页草稿(哨兵 key):用户离开首页再回来,未发送的字还在。
  const homeDraft = useSessionsStore((s) => s.drafts[HOME_DRAFT_KEY] ?? "");
  const setDraft = useSessionsStore((s) => s.setDraft);
  const mentionCandidates = useWorkspaceMentions(cwd);

  // Pending expert (set after "召唤" in the detail modal).
  const pendingExpert = usePendingExpertStore((s) => s.expert);
  const pendingHandledRef = useRef<string | null>(null);

  // When a pending expert arrives with a quickPrompt, pre-fill the composer.
  useEffect(() => {
    if (!pendingExpert) {
      // 已被 dismiss 或未召唤:重置处理记录,使再次召唤同一专家能重新预填。
      pendingHandledRef.current = null;
      return;
    }
    // Only auto-fill once per expert (avoid re-filling on store churn).
    if (pendingHandledRef.current === pendingExpert.expertId) return;
    pendingHandledRef.current = pendingExpert.expertId;
    const currentDraft = useSessionsStore.getState().drafts[HOME_DRAFT_KEY] ?? "";
    if (pendingExpert.quickPrompt && currentDraft.length === 0) {
      fillComposer(pendingExpert.quickPrompt);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingExpert]);

  /** Dismiss the active expert: clear pending store + drop pre-fill guard. */
  const dismissPendingExpert = () => {
    usePendingExpertStore.getState().clear();
    pendingHandledRef.current = null;
  };

  /** 写入 Composer 并聚焦。 */
  const fillComposer = (text: string) => {
    setExternalText(text);
    setExternalTextNonce((n) => n + 1);
  };

  const hasWorkspace = Boolean(cwd);

  if (!apiReady) {
    return (
      <div className="home home--setup">
        <div className="home__inner home__inner--setup">
          <header className="home__header">
            <h1 className="home__title">先把 EchoAgent 接到你的工作区</h1>
          </header>
          <section className="home-setup" aria-label="首次使用设置">
            <div className="home-setup__steps">
              <div className="home-setup__step home-setup__step--active">
                <span className="home-setup__icon"><Cpu size={18} /></span>
                <div>
                  <strong>选择模型</strong>
                  <span>添加一个可用的模型连接，之后任务都会使用它执行。</span>
                </div>
              </div>
              <div className="home-setup__step home-setup__step--active">
                <span className="home-setup__icon"><KeyRound size={18} /></span>
                <div>
                  <strong>填写 API Key 并测试</strong>
                  <span>{setupHint || "在模型设置里填写 Base URL、API Key 和 Model ID。"}</span>
                </div>
              </div>
              <div className={"home-setup__step" + (hasWorkspace ? " home-setup__step--done" : "")}>
                <span className="home-setup__icon">
                  {hasWorkspace ? <CheckCircle2 size={18} /> : <FolderOpen size={18} />}
                </span>
                <div>
                  <strong>选择第一个工作目录</strong>
                  <span>{hasWorkspace ? cwd : "选择 Agent 可以读取和修改的项目目录。"}</span>
                </div>
              </div>
            </div>
            <div className="home-setup__actions">
              <button type="button" className="btn btn--primary" onClick={onOpenSettings}>
                配置模型
              </button>
              {workspaces && workspaces.length > 0 && onSelectWorkspace && (
                <select
                  className="home-setup__workspace"
                  value={cwd ?? ""}
                  onChange={(event) => {
                    if (event.target.value) onSelectWorkspace(event.target.value);
                  }}
                  aria-label="选择工作目录"
                >
                  <option value="">选择工作目录</option>
                  {workspaces.map((workspace) => (
                    <option key={workspace.cwd} value={workspace.cwd}>
                      {workspace.cwd}
                    </option>
                  ))}
                </select>
              )}
            </div>
          </section>
        </div>
      </div>
    );
  }

  return (
    <div className="home">
      <div className="home__inner">
        <header className="home__header">
          <h1 className="home__title">今天想完成什么？</h1>
        </header>

        <section className="home__composer-area">
          <Composer
            streaming={streaming}
            onSend={onSend}
            onCancel={() => {}}
            apiReady={apiReady}
            setupHint={
              setupHint ?? (models?.length
                ? undefined
                : "请先在「设置 → 模型」配置模型"
              )
            }
            onOpenSettings={onOpenSettings}
            onPlaceholder={onPlaceholder}
            externalText={externalText}
            externalTextNonce={externalTextNonce}
            modelId={modelId}
            models={models}
            onModelChange={onModelChange}
            cwd={cwd}
            workspaces={workspaces}
            onSelectWorkspace={onSelectWorkspace}
            showMeta
            draft={homeDraft}
            draftKey={HOME_DRAFT_KEY}
            onDraftChange={(t) => setDraft(HOME_DRAFT_KEY, t)}
            onSelectExpert={onSelectExpert}
            onNavigateConnectors={onNavigateConnectors}
            automationMode={taskMode}
            automationModeDisabled={Boolean(creatingSession) || streaming}
            showAutomationModeBadge
            onAutomationModeChange={onTaskModeChange}
            onOpenKnowledgeBase={onOpenKnowledgeBase}
            onOpenMeetingMinutes={onOpenMeetingMinutes}
            onOpenOrganization={onOpenOrganization}
            commandRefreshKey={commandRefreshKey}
            onClientSlashCommand={onClientSlashCommand}
            filePaths={mentionCandidates.filePaths}
            workspaceSymbols={mentionCandidates.workspaceSymbols}
            activeExpertName={pendingExpert?.name}
            activeExpertAvatar={pendingExpert?.avatarLocal}
            onDismissExpert={dismissPendingExpert}
          />
          {creatingSession && (
            <div className="home__send-status" role="status" aria-live="polite">
              正在创建 Agent 会话…
            </div>
          )}
          {!creatingSession && sendError && (
            <div className="home__send-error" role="alert">
              创建会话失败：{sendError}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
