import { useEffect, useState } from "react";
import {
  AlertTriangle,
  Code2,
  LoaderCircle,
  Send,
  ShieldCheck,
  Sparkles,
} from "lucide-react";

import { ModelSelector, type ModelOption } from "@/components/ModelSelector";
import { PermissionPicker } from "@/components/PermissionPicker";
import { DRAFT_TTL_MS, useAiDraftStore } from "@/features/coding/store/ai-draft-store";

interface TaskStarterProps {
  models: ModelOption[];
  modelId?: string;
  onModelChange: (modelId: string) => void;
  starting: boolean;
  error?: string | null;
  apiReady: boolean;
  /** Files the user pinned as context, shown so the Agent's inputs are visible. */
  contextPaths: string[];
  onStart: (requirement: string) => void;
  onOpenSettings?: () => void;
  onToast?: (message: string) => void;
}

/**
 * Requirement entry for a new task. Echo Code is always an Agent;
 * understanding, planning and validation are automatic workflow stages while
 * permissions remain the independent control for runtime autonomy.
 */
export function TaskStarter({
  models,
  modelId,
  onModelChange,
  starting,
  error,
  apiReady,
  contextPaths,
  onStart,
  onOpenSettings,
  onToast,
}: TaskStarterProps) {
  const [requirement, setRequirement] = useState("");
  const consumeDraft = useAiDraftStore((s) => s.consume);

  // SP3: pre-fill the textarea from the ai-draft store on first mount. The
  // draft is consumed exactly once; if the user already started typing or the
  // draft is stale, we leave the field alone.
  useEffect(() => {
    const draft = consumeDraft();
    if (!draft) return;
    if (draft.createdAt + DRAFT_TTL_MS < Date.now()) return;
    if (draft.prompt) setRequirement(draft.prompt);
  }, [consumeDraft]);

  const submit = () => {
    if (!requirement.trim() || starting) return;
    onStart(requirement.trim());
  };

  return (
    <div className="coding-agent__starter">
      <header className="coding-agent__panel-head">
        <div className="coding-agent__identity">
          <span className="coding-agent__identity-mark" aria-hidden="true">
            <Sparkles size={14} />
          </span>
          <div>
            <strong>Echo Code</strong>
            <span>新任务</span>
          </div>
        </div>
        <span className="coding-agent__ready">准备就绪</span>
      </header>

      <div className="coding-agent__starter-content">
        <div className="coding-agent__starter-main">
          <div className="coding-agent__intro">
            <span className="coding-agent__intro-mark" aria-hidden="true">
              <Code2 size={22} />
            </span>
            <strong>和 Echo 一起构建</strong>
            <p>描述想完成的目标，Agent 会理解工程、拆解复杂任务、分步实施并验证结果。</p>
          </div>

          <div className="coding-agent__starter-card">
            {contextPaths.length > 0 && (
              <div className="coding-agent__context" aria-label="已选定上下文">
                {contextPaths.map((path) => (
                  <span key={path} title={path}>{path.split("/").pop()}</span>
                ))}
              </div>
            )}

            <textarea
              value={requirement}
              onChange={(event) => setRequirement(event.target.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                  event.preventDefault();
                  submit();
                }
              }}
              rows={5}
              placeholder="描述你想完成的任务，例如：实现订单导出并补齐测试…"
              aria-label="任务描述"
            />

            {!apiReady && (
              <div className="coding-agent__warning">
                <AlertTriangle size={13} />
                尚未配置可用模型。
                <button type="button" onClick={onOpenSettings}>前往设置</button>
              </div>
            )}
            {error && (
              <div className="coding-agent__warning" role="alert">
                <AlertTriangle size={13} />
                {error}
              </div>
            )}

            <div className="coding-agent__composer-tools">
              <PermissionPicker onToast={onToast} />
              <ModelSelector modelId={modelId} models={models} onModelChange={onModelChange} />
              <button
                type="button"
                className="coding-agent__send"
                disabled={starting || !requirement.trim() || !modelId}
                onClick={submit}
                aria-label="开始 Agent 任务"
              >
                {starting ? <LoaderCircle size={14} className="is-spinning" /> : <Send size={14} />}
              </button>
            </div>
          </div>

          <div className="coding-agent__checkpoint-note">
            <ShieldCheck size={12} />
            <span>自动分析、拆解、实施并验证；审批模式独立控制操作权限</span>
          </div>
        </div>
      </div>
    </div>
  );
}
