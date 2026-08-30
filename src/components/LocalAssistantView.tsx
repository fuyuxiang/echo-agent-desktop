import { Composer } from "./Composer";
import { SettingsIcon } from "@/foundation/components/Icon/icons";
import type { ModelOption } from "./ModelSelector";
import { useSessionsStore, ASSISTANT_DRAFT_KEY } from "@/stores/sessions-store";

/**
 * 本地助理页 — 1:1 对齐 EchoAgent「本地助理」tab（claw-local-tab = 聊天壳）。
 *
 * 视觉结构（对照目标截图）:
 *  - 顶部 header: 标题「本地助理」+「已连接：」+ 微信小程序 chip + 齿轮按钮
 *  - 中部: 空白消息区（无空状态文案）
 *  - 底部: Composer 卡片（卡片内 + 默认权限 … Auto 麦克风 发送）+ 免责声明
 *
 * 该页即一个可直接对话的入口：在 Composer 发送会新建会话并切到 ChatView。
 */
export function LocalAssistantView({
  onSend,
  streaming,
  apiReady,
  onOpenSettings,
  onPlaceholder,
  modelId,
  models,
  onModelChange,
}: {
  onSend: (text: string) => boolean | void | Promise<boolean | void>;
  streaming: boolean;
  apiReady: boolean;
  onOpenSettings?: () => void;
  onPlaceholder?: (label: string) => void;
  /** 模型选择器（与聊天页 Composer 一致；缺省时退化为静态 Auto 按钮）。 */
  modelId?: string;
  models?: ModelOption[];
  onModelChange?: (id: string) => void;
}) {
  // 本地助理页草稿(哨兵 key):离开再回来未发送的字还在。
  const draft = useSessionsStore((s) => s.drafts[ASSISTANT_DRAFT_KEY] ?? "");
  const setDraft = useSessionsStore((s) => s.setDraft);
  return (
    <div className="local-assistant">
      <header className="local-assistant__header" data-tauri-drag-region>
        <h1 className="local-assistant__title">本地助理</h1>
        <span className="local-assistant__conn-label">运行状态：</span>
        <span className="local-assistant__conn-chip" role="status">
          <span
            className={`local-assistant__status-dot ${apiReady ? "is-ready" : ""}`}
            aria-hidden="true"
          />
          <span>{apiReady ? "本地 Agent 已就绪" : "待配置模型"}</span>
        </span>
        <button
          type="button"
          className="local-assistant__settings"
          onClick={onOpenSettings}
          aria-label="打开助理设置"
          title="打开助理设置"
        >
          <SettingsIcon size="sm" />
        </button>
      </header>

      <div className="local-assistant__body" />

      <div className="local-assistant__footer">
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
          modelId={modelId}
          models={models}
          onModelChange={onModelChange}
          permissionInline
          showDisclaimer
          placeholder="今天帮你做些什么？ @ 引用对话文件，/ 调用技能与指令"
          draft={draft}
          draftKey={ASSISTANT_DRAFT_KEY}
          onDraftChange={(t) => setDraft(ASSISTANT_DRAFT_KEY, t)}
        />
      </div>
    </div>
  );
}
