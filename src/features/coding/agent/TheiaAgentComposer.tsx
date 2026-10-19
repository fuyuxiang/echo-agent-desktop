import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowUp, LoaderCircle, X } from "lucide-react";

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
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const queuedDraft = useAiDraftStore((state) => state.draft);
  const consumeDraft = useAiDraftStore((state) => state.consume);

  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const resize = () => {
      input.style.height = "0px";
      // CSS bounds the field; measuring the draft also lets it shrink after
      // deleting text. Only the input scrolls, keeping the toolbar visible.
      input.style.height = `${input.scrollHeight}px`;
    };
    resize();
    let width = input.getBoundingClientRect().width;
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => {
      const next = input.getBoundingClientRect().width;
      if (next !== width) { width = next; resize(); }
    });
    observer?.observe(input);
    // Settings changes rem-based typography without changing the field width.
    // Watch the root style used by applyFontSize so an existing draft resizes
    // before the next paint, preserving the textarea's focus and selection.
    const typographyObserver = new MutationObserver(resize);
    typographyObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });
    window.addEventListener("resize", resize);
    return () => {
      observer?.disconnect();
      typographyObserver.disconnect();
      window.removeEventListener("resize", resize);
    };
  }, [text]);

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
  const busy = submitting || sending || (!task && starting);
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
      if (accepted !== false) setText((current) => current === text ? "" : current);
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
          ref={inputRef}
          className="echo-theia-agent__input"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (!event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229 && (event.metaKey || event.ctrlKey) && event.key === "Enter") {
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
          aria-label={task ? "补充开发要求" : "任务描述"}
          disabled={sessionUnavailable || sending}
        />
        {!task && !apiReady && (
          <div className="coding-agent__warning">
            <AlertTriangle size={13} /> 尚未配置可用模型。
            <button type="button" onClick={onOpenSettings}>前往设置</button>
          </div>
        )}
        {startError && (
          <div className="coding-agent__warning" role="alert"><AlertTriangle size={13} />{startError}</div>
        )}
        <div className="echo-theia-agent__composer-tools" role="group" aria-label="开发任务输入选项">
          <PermissionPicker onToast={onToast} sessionId={sessionId ?? undefined} />
          <ModelSelector modelId={modelId} models={models} onModelChange={onModelChange} ariaLabel="开发任务模型" disabled={busy || sessionUnavailable} />
          <button type="button" className="echo-theia-agent__send" disabled={!canSend} onClick={() => void submit()} aria-label={task ? "发送给 Agent" : "开始 Agent 任务"} aria-busy={busy} title={busy ? "正在发送…" : `${shortcutLabel("⌘ Enter", "Ctrl+Enter")} 发送；Enter 换行`}>
            {busy ? <LoaderCircle size={16} className="is-spinning" /> : <ArrowUp size={17} />}
          </button>
        </div>
      </div>
    </div>
  );
}
