import { useState, type KeyboardEvent } from "react";
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

import { CODING_MODE_OPTIONS, codingModeOption } from "../lib/mode";
import type { CodingMode } from "../lib/types";

interface TaskStarterProps {
  models: ModelOption[];
  modelId?: string;
  onModelChange: (modelId: string) => void;
  starting: boolean;
  error?: string | null;
  apiReady: boolean;
  /** Files the user pinned as context, shown so the Agent's inputs are visible. */
  contextPaths: string[];
  onStart: (requirement: string, mode: CodingMode) => void;
  onOpenSettings?: () => void;
  onToast?: (message: string) => void;
}

/**
 * Requirement entry for a new task.
 *
 * Mode captures user intent; permissions remain an independent control for
 * runtime autonomy. Validation is part of Agent mode rather than an opt-in.
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
  const [mode, setMode] = useState<CodingMode>("agent");
  const modeConfig = codingModeOption(mode);

  const submit = () => {
    if (!requirement.trim() || starting) return;
    onStart(requirement.trim(), mode);
  };

  const moveModeFocus = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | null = null;
    if (["ArrowRight", "ArrowDown"].includes(event.key)) {
      nextIndex = (index + 1) % CODING_MODE_OPTIONS.length;
    } else if (["ArrowLeft", "ArrowUp"].includes(event.key)) {
      nextIndex = (index - 1 + CODING_MODE_OPTIONS.length) % CODING_MODE_OPTIONS.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = CODING_MODE_OPTIONS.length - 1;
    }
    if (nextIndex === null) return;
    event.preventDefault();
    setMode(CODING_MODE_OPTIONS[nextIndex].id);
    event.currentTarget.parentElement
      ?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[nextIndex]
      ?.focus();
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
            <strong>你想怎么处理这个任务？</strong>
            <p>选择 Ask 了解代码、Plan 先审核方案，或让 Agent 直接完成并验证。</p>
          </div>

          <div className="coding-agent__starter-card">
            {contextPaths.length > 0 && (
              <div className="coding-agent__context" aria-label="已选定上下文">
                {contextPaths.map((path) => (
                  <span key={path} title={path}>
                    {path.split("/").pop()}
                  </span>
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
              placeholder={modeConfig.placeholder}
              aria-label="任务描述"
            />

            {!apiReady && (
              <div className="coding-agent__warning">
                <AlertTriangle size={13} />
                尚未配置可用模型。
                <button type="button" onClick={onOpenSettings}>
                  前往设置
                </button>
              </div>
            )}
            {error && (
              <div className="coding-agent__warning" role="alert">
                <AlertTriangle size={13} />
                {error}
              </div>
            )}

            <div className="coding-agent__composer-tools">
              <div className="coding-agent__mode-switch" role="radiogroup" aria-label="工作模式">
                {CODING_MODE_OPTIONS.map((entry, index) => (
                  <button
                    key={entry.id}
                    type="button"
                    role="radio"
                    aria-checked={mode === entry.id}
                    tabIndex={mode === entry.id ? 0 : -1}
                    className={mode === entry.id ? "is-active" : undefined}
                    title={entry.description}
                    onClick={() => setMode(entry.id)}
                    onKeyDown={(event) => moveModeFocus(event, index)}
                  >
                    {entry.label}
                  </button>
                ))}
              </div>
              <PermissionPicker onToast={onToast} />
              <ModelSelector modelId={modelId} models={models} onModelChange={onModelChange} />
              <button
                type="button"
                className="coding-agent__send"
                disabled={starting || !requirement.trim() || !modelId}
                onClick={submit}
                aria-label={modeConfig.submitLabel}
              >
                {starting ? <LoaderCircle size={14} className="is-spinning" /> : <Send size={14} />}
              </button>
            </div>
          </div>

          <div className="coding-agent__checkpoint-note">
            <ShieldCheck size={12} />
            <span>{modeConfig.description}；权限策略独立控制操作审批</span>
          </div>
        </div>
      </div>
    </div>
  );
}
