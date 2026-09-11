import { useState } from "react";
import { AlertTriangle, CheckCircle2, ListChecks, LoaderCircle, Send, Square } from "lucide-react";

import { ExecutionProcess } from "@/components/ExecutionProcess";
import { Markdown } from "@/components/Markdown";
import { ModelSelector, type ModelOption } from "@/components/ModelSelector";
import { PermissionInlineCard } from "@/components/PermissionDialog";
import { PermissionPicker } from "@/components/PermissionPicker";
import { QuestionInlineCard } from "@/components/QuestionInlineCard";
import type { ChatMessage } from "@/stores/session-store";

import { describePhase } from "../lib/phase";
import type { CodingTask } from "../lib/types";

interface AgentPaneProps {
  task: CodingTask;
  sessionId: string | null;
  messages: ChatMessage[];
  streaming: boolean;
  /** The orchestrator's reason for the current phase, or a blocker explanation. */
  phaseReason?: string;
  blocker?: string | null;
  awaitingPermission: boolean;
  awaitingQuestion: boolean;
  models: ModelOption[];
  modelId?: string;
  sending: boolean;
  onModelChange: (modelId: string) => void;
  onSend: (text: string) => void;
  onCancel: () => void;
  onApprovePlan: () => void;
  onOpenReport: () => void;
  onToast?: (message: string) => void;
}

/**
 * The Agent's working surface: what it is doing, what it needs from the user, and
 * the follow-up input.
 *
 * Phase is shown as a single status line rather than a progress diagram — the
 * workbench should look like a tool, not a demo of its own pipeline.
 */
export function AgentPane({
  task,
  sessionId,
  messages,
  streaming,
  phaseReason,
  blocker,
  awaitingPermission,
  awaitingQuestion,
  models,
  modelId,
  sending,
  onModelChange,
  onSend,
  onCancel,
  onApprovePlan,
  onOpenReport,
  onToast,
}: AgentPaneProps) {
  const [followup, setFollowup] = useState("");
  const phase = describePhase(task.phase);

  const submit = () => {
    if (!followup.trim() || sending || streaming) return;
    onSend(followup.trim());
    setFollowup("");
  };

  return (
    <div className="coding-agent">
      <div className="coding-agent__head">
        <span className={`coding-agent__phase is-${phase.tone}`}>
          {phase.active && <LoaderCircle size={12} className="is-spinning" />}
          {task.phase === "delivered" && <CheckCircle2 size={12} />}
          {task.phase === "blocked" && <AlertTriangle size={12} />}
          {phase.label}
        </span>
        {streaming && (
          <button type="button" className="coding-agent__stop" onClick={onCancel}>
            <Square size={11} /> 停止
          </button>
        )}
      </div>

      {phaseReason && !blocker && <div className="coding-agent__reason">{phaseReason}</div>}

      {blocker && (
        <div className="coding-agent__blocker" role="alert">
          <AlertTriangle size={13} />
          <div>
            <strong>需要人工介入</strong>
            <p>{blocker}</p>
          </div>
        </div>
      )}

      {task.phase === "planning" && (
        <div className="coding-agent__decision">
          <ListChecks size={13} />
          <span>Agent 已给出计划，批准后才会修改文件。</span>
          <button type="button" onClick={onApprovePlan}>
            批准计划
          </button>
        </div>
      )}

      {task.phase === "delivered" && (
        <div className="coding-agent__decision is-good">
          <CheckCircle2 size={13} />
          <span>门禁全部通过。</span>
          <button type="button" onClick={onOpenReport}>
            查看交付报告
          </button>
        </div>
      )}

      {(awaitingPermission || awaitingQuestion) && (
        <div className="coding-agent__interaction" aria-label="等待你的操作">
          {awaitingPermission && <PermissionInlineCard sessionId={sessionId} />}
          {awaitingQuestion && <QuestionInlineCard sessionId={sessionId} />}
        </div>
      )}

      <div className="coding-agent__stream">
        {messages.length === 0 && (
          <div className="coding-row">Agent 正在准备工程上下文…</div>
        )}
        {messages.map((entry) =>
          entry.role === "user" ? (
            <div className="coding-agent__user" key={entry.id}>
              {entry.parts.map((part, index) =>
                part.kind === "text" ? (
                  <Markdown key={index} complete>
                    {part.text}
                  </Markdown>
                ) : null,
              )}
            </div>
          ) : (
            <ExecutionProcess
              key={entry.id}
              parts={entry.parts}
              active={!entry.complete}
              startedAt={entry.startedAt}
              completedAt={entry.completedAt}
              stopReason={entry.stopReason}
              cancelTrigger={entry.cancelTrigger}
              cancellationCategory={entry.cancellationCategory}
              agentResult={entry.agentResult}
            />
          ),
        )}
      </div>

      <div className="coding-agent__composer">
        <textarea
          value={followup}
          onChange={(event) => setFollowup(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              submit();
            }
          }}
          rows={2}
          placeholder="继续当前任务；⌘ Enter 发送…"
          aria-label="给 Agent 的补充要求"
          disabled={sending || streaming}
        />
        <div className="coding-agent__composer-tools">
          <PermissionPicker onToast={onToast} sessionId={sessionId ?? undefined} />
          <ModelSelector modelId={modelId} models={models} onModelChange={onModelChange} />
          <button
            type="button"
            className="coding-agent__send"
            disabled={!followup.trim() || sending || streaming}
            onClick={submit}
            aria-label="发送给 Agent"
          >
            <Send size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
