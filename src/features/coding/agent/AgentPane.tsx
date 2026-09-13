import { useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  LoaderCircle,
  Send,
  Sparkles,
  Square,
} from "lucide-react";

import { ExecutionProcess } from "@/components/ExecutionProcess";
import { Markdown } from "@/components/Markdown";
import { ModelSelector, type ModelOption } from "@/components/ModelSelector";
import { PermissionInlineCard } from "@/components/PermissionDialog";
import { PermissionPicker } from "@/components/PermissionPicker";
import { QuestionInlineCard } from "@/components/QuestionInlineCard";
import type { ChatMessage } from "@/stores/session-store";

import { describePhase } from "../lib/phase";
import type { ChangeSet, CodingTask, VerificationRecord } from "../lib/types";

interface AgentPaneProps {
  task: CodingTask;
  changeSet: ChangeSet | null;
  verifications: VerificationRecord[];
  sessionId: string | null;
  messages: ChatMessage[];
  streaming: boolean;
  phaseReason?: string;
  blocker?: string | null;
  awaitingPermission: boolean;
  awaitingQuestion: boolean;
  models: ModelOption[];
  modelId?: string;
  sending: boolean;
  onModelChange: (modelId: string) => void | Promise<void>;
  onSend: (text: string, mutating?: boolean) => boolean | void | Promise<boolean | void>;
  onCancel: () => void;
  onOpenChanges: () => void;
  onOpenReport: () => void;
  onToast?: (message: string) => void;
}

/** Agent activity, interaction requests and delivery summary for one task. */
export function AgentPane({
  task,
  changeSet,
  verifications,
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
  onOpenChanges,
  onOpenReport,
  onToast,
}: AgentPaneProps) {
  const [followup, setFollowup] = useState("");
  const phase = describePhase(task.phase);
  const sessionUnavailable = !sessionId;
  const changes = changeSet?.changes ?? [];
  const latestChecks = new Map<string, VerificationRecord>();
  for (const record of verifications) latestChecks.set(record.command, record);
  const passedCheckCount = [...latestChecks.values()].filter(
    (record) => record.status === "passed",
  ).length;
  const verificationSummary = passedCheckCount > 0
    ? `${passedCheckCount} 项自动检查已通过`
    : "未检测到可运行的自动检查";
  const completedNodes = task.taskNodes.filter((node) => node.status === "success").length;
  const activeNode = task.taskNodes.find((node) => node.status === "running");

  const submit = async () => {
    if (!followup.trim() || sending || streaming) return;
    const sent = await onSend(followup.trim());
    if (sent !== false) setFollowup("");
  };

  return (
    <div className="coding-agent">
      <header className="coding-agent__panel-head">
        <div className="coding-agent__identity">
          <span className="coding-agent__identity-mark" aria-hidden="true">
            <Sparkles size={14} />
          </span>
          <div>
            <strong>Agent</strong>
            <span title={task.name}>{task.name}</span>
          </div>
        </div>
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
      </header>

      <div className="coding-agent__body">
        {phaseReason && !blocker && task.phase !== "delivered" && (
          <div className="coding-agent__reason">{phaseReason}</div>
        )}

        {task.planRevision && task.taskNodes.length > 0 && phase.active && (
          <div className="coding-agent__workflow-progress" aria-label="执行计划进度">
            <span>执行计划 {completedNodes}/{task.taskNodes.length}</span>
            {activeNode && <strong>{activeNode.planKey} · {activeNode.content}</strong>}
          </div>
        )}

        {task.planIssues.length > 0 && (
          <div
            className={`coding-agent__blocker ${task.planIssues.some((issue) => issue.severity === "error") ? "" : "is-warning"}`}
            role={task.planIssues.some((issue) => issue.severity === "error") ? "alert" : "status"}
          >
            <AlertTriangle size={13} />
            <div>
              <strong>{task.planIssues.some((issue) => issue.severity === "error") ? "执行计划需要修正" : "执行计划提示"}</strong>
              {task.nextAction === "revise_plan" && <p>Agent 将自动修订计划，无需手动重新提交任务。</p>}
              {task.planIssues.map((issue) => <p key={`${issue.code}:${issue.nodeKeys.join(",")}`}>{issue.message}</p>)}
            </div>
          </div>
        )}

        {blocker && (
          <div className="coding-agent__blocker" role="alert">
            <AlertTriangle size={13} />
            <div>
              <strong>需要人工介入</strong>
              <p>{blocker}</p>
            </div>
          </div>
        )}

        {task.phase === "delivered" && (
          <div className="coding-agent__decision is-good">
            <CheckCircle2 size={13} />
            <div className="coding-agent__decision-copy">
              <strong>任务已完成</strong>
              <span>{verificationSummary}，共修改 {changes.length} 个文件。</span>
            </div>
            <div className="coding-agent__decision-actions">
              <button type="button" onClick={onOpenChanges}>查看变更</button>
              <button type="button" onClick={onOpenReport}>交付报告</button>
            </div>
          </div>
        )}

        {(awaitingPermission || awaitingQuestion) && (
          <div className="coding-agent__interaction" aria-label="等待你的操作">
            {awaitingPermission && <PermissionInlineCard sessionId={sessionId} />}
            {awaitingQuestion && <QuestionInlineCard sessionId={sessionId} />}
          </div>
        )}

        <div className="coding-agent__stream">
          {messages.length === 0 && sessionId && phase.active && (
            <div className="coding-row">Agent 正在准备工程上下文…</div>
          )}
          {messages.length === 0 && !sessionId && (
            <div className="coding-row">Agent 会话未启动。</div>
          )}
          {messages.length === 0 && sessionId && !phase.active && (
            <div className="coding-row">当前任务暂无对话记录。</div>
          )}
          {messages.map((entry) =>
            entry.role === "user" ? (
              <div className="coding-agent__user" key={entry.id}>
                {entry.parts.map((part, index) =>
                  part.kind === "text" ? (
                    <Markdown key={index} complete>{part.text}</Markdown>
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
                void submit();
              }
            }}
            rows={2}
            placeholder={sessionUnavailable ? "当前任务未绑定 Agent 会话" : "继续当前任务；⌘ Enter 发送…"}
            aria-label="给 Agent 的补充要求"
            disabled={sessionUnavailable || sending || streaming}
          />
          <div className="coding-agent__composer-tools">
            <PermissionPicker onToast={onToast} sessionId={sessionId ?? undefined} />
            <ModelSelector modelId={modelId} models={models} onModelChange={onModelChange} />
            <button
              type="button"
              className="coding-agent__send"
              disabled={sessionUnavailable || !followup.trim() || sending || streaming}
              onClick={() => void submit()}
              aria-label="发送给 Agent"
            >
              <Send size={14} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
