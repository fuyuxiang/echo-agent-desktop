import { useState } from "react";
import { AlertTriangle, Code2, ListChecks, LoaderCircle, Send } from "lucide-react";

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
  onStart: (requirement: string, planRequired: boolean) => void;
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

  const submit = () => {
    if (!requirement.trim() || starting) return;
    onStart(requirement.trim(), planRequired);
  };

  return (
    <div className="coding-agent__starter">
      <div className="coding-agent__intro">
        <Code2 size={22} />
        <strong>今天要构建什么？</strong>
        <p>用自然语言描述目标，Echo 会读取工程规则与相关代码，在当前工作区完成任务。</p>
      </div>

      <div className="coding-agent__suggestions">
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
        rows={4}
        placeholder="让 Echo 实现功能、修复问题或补齐测试…"
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
        <label className="coding-agent__plan">
          <input
            type="checkbox"
            checked={planRequired}
            onChange={(event) => setPlanRequired(event.target.checked)}
          />
          <ListChecks size={12} />
          先给计划
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
  );
}
