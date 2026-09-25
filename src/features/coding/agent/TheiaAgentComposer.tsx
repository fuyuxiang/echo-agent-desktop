import { useEffect, useRef, useState } from "react";
import { AlertTriangle, LoaderCircle, Send, X } from "lucide-react";

import { ModelSelector, type ModelOption } from "@/components/ModelSelector";
import { PermissionPicker } from "@/components/PermissionPicker";
import { DRAFT_TTL_MS, useAiDraftStore } from "@/features/coding/store/ai-draft-store";
import { shortcutLabel } from "@/lib/platform";

import { codingTaskDraftKey } from "../lib/task-draft-key";
import type { CodingTask } from "../lib/types";

interface TheiaAgentComposerProps {
  workspaceRoot: string;
  task: CodingTask | null;
  sessionId: string | null;
  models: ModelOption[];
  modelId?: string;
  contextPaths: string[];
  apiReady: boolean;
  startError?: string | null;
  starting: boolean;
  sending: boolean;
  streaming: boolean;
  onModelChange: (modelId: string) => void | Promise<void>;
  onStart: (requirement: string) => void | Promise<void>;
  onSend: (text: string) => boolean | void | Promise<boolean | void>;
  onRemoveContext: (path: string) => void;
  onDraftContextPaths: (paths: string[]) => void;
  onOpenSettings?: () => void;
  onToast?: (message: string) => void;
  suggestedPrompt?: string | null;
}

function draftKey(root: string, taskId?: string): string {
  return taskId
    ? `echo-coding-followup-v1:${encodeURIComponent(root)}:${encodeURIComponent(taskId)}`
    : codingTaskDraftKey(root);
}

function readDraft(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

/** One composer stays at the same position while the task's views change. */
export function TheiaAgentComposer({
  workspaceRoot,
  task,
  sessionId,
  models,
  modelId,
  contextPaths,
  apiReady,
  startError,
  starting,
  sending,
  streaming,
  onModelChange,
  onStart,
  onSend,
  onRemoveContext,
  onDraftContextPaths,
  onOpenSettings,
  onToast,
  suggestedPrompt,
}: TheiaAgentComposerProps) {
  const key = draftKey(workspaceRoot, task?.id);
  const [text, setText] = useState(() => readDraft(key));
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const queuedDraft = useAiDraftStore((state) => state.draft);
  const consumeDraft = useAiDraftStore((state) => state.consume);

  useEffect(() => {
    if (suggestedPrompt && !task) setText(suggestedPrompt);
  }, [suggestedPrompt, task]);

  useEffect(() => {
    if (!queuedDraft) return;
    const draft = consumeDraft();
    if (!draft || draft.createdAt + DRAFT_TTL_MS < Date.now()) return;
    if (draft.prompt) setText(draft.prompt);
    if (draft.contextPaths.length > 0) onDraftContextPaths(draft.contextPaths);
  }, [queuedDraft, consumeDraft, onDraftContextPaths]);

  useEffect(() => {
    try {
      if (text) localStorage.setItem(key, text);
      else localStorage.removeItem(key);
    } catch {
      // Draft recovery never blocks editing or sending.
    }
  }, [key, text]);

  const sessionUnavailable = Boolean(task && (!sessionId || task.sessionId !== sessionId));
  const verifying = task?.phase === "verifying";
  const canSend = !submitting && Boolean(text.trim()) && (task
    ? !sessionUnavailable && !sending && !streaming && !verifying
    : !starting && apiReady && Boolean(modelId));

  const submit = async () => {
    const prompt = text.trim();
    if (!prompt || !canSend || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      if (!task) {
        await onStart(prompt);
        return;
      }
      const accepted = await onSend(prompt);
      if (accepted !== false) setText("");
    } catch (error) {
      onToast?.(`发送失败：${String(error).replace(/^Error:\s*/, "")}`);
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  return (
    <div className="echo-theia-agent__composer" aria-label={task ? "任务追问" : "新建开发任务"}>
      {contextPaths.length > 0 && (
        <div className="echo-theia-agent__context-chips" aria-label="任务上下文">
          {contextPaths.map((path) => (
            <span key={path} className="echo-theia-agent__context-chip" title={path}>
              <span>{path.split(/[\\/]/).pop()}</span>
              <button type="button" aria-label={`移除上下文 ${path}`} onClick={() => onRemoveContext(path)}><X size={11} /></button>
            </span>
          ))}
        </div>
      )}
      <div className="echo-theia-agent__composer-box">
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              void submit();
            }
          }}
          rows={3}
          placeholder={!task
            ? "描述要完成的开发任务…"
            : sessionUnavailable
              ? "当前任务未绑定 Agent 会话"
              : verifying
                ? "可写入草稿，验证完成后手动发送…"
                : streaming
                  ? "可写入草稿，本轮完成后手动发送…"
                  : "给 Agent 补充要求或让它修改当前代码…"}
          aria-label={task ? "给 Agent 的补充要求" : "任务描述"}
          disabled={sessionUnavailable || sending}
        />
        {!task && !apiReady && (
          <div className="coding-agent__warning">
            <AlertTriangle size={13} /> 尚未配置可用模型。
            <button type="button" onClick={onOpenSettings}>前往设置</button>
          </div>
        )}
        {!task && startError && (
          <div className="coding-agent__warning" role="alert"><AlertTriangle size={13} />{startError}</div>
        )}
        <div className="coding-agent__composer-tools">
          <PermissionPicker onToast={onToast} sessionId={sessionId ?? undefined} />
          <ModelSelector modelId={modelId} models={models} onModelChange={onModelChange} />
          <button type="button" className="coding-agent__send" disabled={!canSend} onClick={() => void submit()} aria-label={task ? "发送给 Agent" : "开始 Agent 任务"} title={`${shortcutLabel("⌘ Enter", "Ctrl+Enter")} 发送`}>
            {starting && !task ? <LoaderCircle size={14} className="is-spinning" /> : <Send size={14} />}
          </button>
        </div>
      </div>
    </div>
  );
}
