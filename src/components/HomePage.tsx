import { useEffect, useRef, useState } from "react";
import { Composer } from "./Composer";
import type { ModelOption } from "./ModelSelector";
import type { WorkspaceInfo } from "@/lib/agent-client";
import type { AgentEntry } from "@/lib/types";
import { useSessionsStore, HOME_DRAFT_KEY } from "@/stores/sessions-store";
import { usePendingExpertStore } from "@/stores/pending-expert-store";
import type { SlashCommandInvocation } from "@/lib/slash-commands";

/** EchoAgent 首页：单一任务入口。 */
export function HomePage({
  onSend,
  streaming,
  apiReady,
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
  commandRefreshKey,
  onClientSlashCommand,
}: {
  onSend: (text: string, attachments?: string[]) => boolean | void | Promise<boolean | void>;
  streaming: boolean;
  apiReady: boolean;
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
  commandRefreshKey?: number;
  onClientSlashCommand?: (
    invocation: SlashCommandInvocation,
  ) => boolean | void | Promise<boolean | void>;
}) {
  // 受控填充 Composer 的内容 + nonce（召唤专家后写入 quick prompt）。
  const [externalText, setExternalText] = useState("");
  const [externalTextNonce, setExternalTextNonce] = useState(0);
  // 首页草稿(哨兵 key):用户离开首页再回来,未发送的字还在。
  const homeDraft = useSessionsStore((s) => s.drafts[HOME_DRAFT_KEY] ?? "");
  const setDraft = useSessionsStore((s) => s.setDraft);

  // Pending expert (set after "召唤" in the detail modal).
  const pendingExpert = usePendingExpertStore((s) => s.expert);
  const pendingHandledRef = useRef<string | null>(null);

  // When a pending expert arrives with a quickPrompt, pre-fill the composer.
  useEffect(() => {
    if (!pendingExpert) return;
    // Only auto-fill once per expert (avoid re-filling if user clears it).
    if (pendingHandledRef.current === pendingExpert.expertId) return;
    pendingHandledRef.current = pendingExpert.expertId;
    if (pendingExpert.quickPrompt) {
      fillComposer(pendingExpert.quickPrompt);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingExpert]);

  /** 写入 Composer 并聚焦。 */
  const fillComposer = (text: string) => {
    setExternalText(text);
    setExternalTextNonce((n) => n + 1);
  };

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
              models?.length
                ? undefined
                : "请先在「设置 → 模型」配置模型"
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
            commandRefreshKey={commandRefreshKey}
            onClientSlashCommand={onClientSlashCommand}
            activeExpertName={pendingExpert?.name}
            activeExpertAvatar={pendingExpert?.avatarLocal}
          />
        </section>
      </div>
    </div>
  );
}
