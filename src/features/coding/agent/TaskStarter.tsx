import { useState } from "react";
import {
  AlertTriangle,
  Code2,
  ListChecks,
  LoaderCircle,
  Send,
  ShieldCheck,
  Sparkles,
} from "lucide-react";

import { ModelSelector, type ModelOption } from "@/components/ModelSelector";
import { PermissionPicker } from "@/components/PermissionPicker";

interface TaskStarterProps {
  models: ModelOption[];
  modelId?: string;
  onModelChange: (modelId: string) => void;
  starting: boolean;
  error?: string | null;
  apiReady: boolean;
  /** Files the user pinned as context, shown so the Agent's inputs are visible. */
  contextPaths: string[];
  onStart: (requirement: string, planRequired: boolean, reviewRequired: boolean) => void;
  onOpenSettings?: () => void;
  onToast?: (message: string) => void;
}

const SUGGESTIONS = [
  { label: "补齐测试", text: "分析当前测试覆盖缺口，为关键路径补齐可靠的自动化测试" },
  { label: "实现新功能", text: "实现一个新功能，沿用现有架构、交互和测试约定" },
  { label: "定位问题", text: "复现并定位当前问题的根因，完成最小修复" },
];

/**
 * Requirement entry for a new task.
 *
 * There is one switch rather than a role/strategy matrix: the model decides
 * whether a request is a question or an implementation, and read-only safety
 * comes from the permission mode rather than from guessing intent in the UI.
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
  const [planRequired, setPlanRequired] = useState(false);
  const [reviewRequired, setReviewRequired] = useState(false);

  const submit = () => {
    if (!requirement.trim() || starting) return;
    onStart(requirement.trim(), planRequired, reviewRequired);
  };

  return (
    <div className="coding-agent__starter">
      <header className="coding-agent__panel-head">
        <div className="coding-agent__identity">
          <span className="coding-agent__identity-mark" aria-hidden="true">
            <Sparkles size={14} />
          </span>
          <div>
            <strong>Agent</strong>
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
            <p>描述你想完成的目标，Agent 会理解当前工程、执行修改并呈现可审阅的结果。</p>
          </div>

          <div className="coding-agent__starter-card">
            <div className="coding-agent__suggestions" aria-label="常用任务">
              {SUGGESTIONS.map((suggestion) => (
                <button key={suggestion.label} type="button" onClick={() => setRequirement(suggestion.text)}>
                  {suggestion.label}
                </button>
              ))}
            </div>

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
              placeholder="描述一个任务，例如：优化这个页面的布局与视觉层级…"
              aria-label="开发需求"
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
              <label
                className="coding-agent__plan"
                title="开启后，Agent 会先提交可编辑的执行计划，批准后再修改代码"
              >
                <input
                  type="checkbox"
                  checked={planRequired}
                  onChange={(event) => setPlanRequired(event.target.checked)}
                />
                <ListChecks size={12} />
                先给计划
              </label>
              <label
                className="coding-agent__plan"
                title="开启后，Agent 完成检查会等待你逐个查看变更并确认；默认自动完成"
              >
                <input
                  type="checkbox"
                  checked={reviewRequired}
                  onChange={(event) => setReviewRequired(event.target.checked)}
                />
                <ShieldCheck size={12} />
                完成前验收
              </label>
              <PermissionPicker onToast={onToast} />
              <ModelSelector modelId={modelId} models={models} onModelChange={onModelChange} />
              <button
                type="button"
                className="coding-agent__send"
                disabled={starting || !requirement.trim() || !modelId}
                onClick={submit}
                aria-label="开始开发任务"
              >
                {starting ? <LoaderCircle size={14} className="is-spinning" /> : <Send size={14} />}
              </button>
            </div>
          </div>

          <div className="coding-agent__checkpoint-note">
            <ShieldCheck size={12} />
            <span>自动保护源码与配置改动；依赖缓存和构建产物不纳入检查点</span>
          </div>
        </div>
      </div>
    </div>
  );
}
