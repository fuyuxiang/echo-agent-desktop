import { AlertTriangle, CheckCircle2, CircleDot, LoaderCircle, MinusCircle } from "lucide-react";

import { describePhase } from "../../lib/phase";
import {
  type CodingTask,
  type ExecutionLedgerEvent,
  type RepairRound,
  type TaskNode,
  type TaskNodeStatus,
} from "../../lib/types";

interface TaskDagTabProps {
  task: CodingTask | null;
  repairRounds: RepairRound[];
  maxRepairRounds: number;
  changedFileCount: number;
  problemCount: number;
  ledger?: ExecutionLedgerEvent[];
  onOpenFile: (path: string) => void;
}

const STATUS_TEXT: Record<TaskNodeStatus, string> = {
  pending: "待执行",
  running: "执行中",
  success: "已完成",
  failed: "失败",
  blocked: "阻塞",
};

function StatusIcon({ status }: { status: TaskNodeStatus }) {
  if (status === "success") return <CheckCircle2 size={13} />;
  if (status === "running") return <LoaderCircle size={13} className="is-spinning" />;
  if (status === "failed" || status === "blocked") return <AlertTriangle size={13} />;
  return <CircleDot size={13} />;
}

/** One task node with its dependencies and touched files. */
function NodeRow({ node, onOpenFile }: { node: TaskNode; onOpenFile: (path: string) => void }) {
  const hasContracts = node.consumes.length > 0
    || node.produces.length > 0
    || node.acceptanceCriteria.length > 0
    || node.verificationCommands.length > 0;
  return (
    <div className={`coding-dag__node is-${node.status}`}>
      <div className="coding-dag__node-head">
        <StatusIcon status={node.status} />
        <b>{node.planKey || node.id}</b>
        <span>{node.content}</span>
        <em>{STATUS_TEXT[node.status]}</em>
      </div>
      {(node.dependencies.length > 0 || node.relatedFiles.length > 0) && (
        <div className="coding-dag__node-meta">
          {node.dependencies.length > 0 && <span>依赖 {node.dependencies.join("、")}</span>}
          {node.relatedFiles.map((path) => (
            <button key={path} type="button" onClick={() => onOpenFile(path)}>
              {path}
            </button>
          ))}
        </div>
      )}
      {hasContracts && (
        <div className="coding-dag__contracts">
          {node.consumes.length > 0 && (
            <div><strong>依赖接口</strong><span>{node.consumes.join("、")}</span></div>
          )}
          {node.produces.length > 0 && (
            <div><strong>产出接口</strong><span>{node.produces.join("、")}</span></div>
          )}
          {node.acceptanceCriteria.length > 0 && (
            <div><strong>节点验收</strong><span>{node.acceptanceCriteria.join("；")}</span></div>
          )}
          {node.verificationCommands.length > 0 && (
            <div><strong>验证命令</strong><code>{node.verificationCommands.join(" · ")}</code></div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Task breakdown and progress.
 *
 * Opened as a tab rather than shown as permanent chrome — progress is something
 * the user asks for, not something the workbench advertises continuously.
 */
export function TaskDagTab({
  task,
  repairRounds,
  maxRepairRounds,
  changedFileCount,
  problemCount,
  ledger = [],
  onOpenFile,
}: TaskDagTabProps) {
  if (!task) {
    return <div className="coding-doc__empty">新建开发任务后即可查看拆解与进度。</div>;
  }

  const phase = describePhase(task.phase);
  const nodes = task.taskNodes;
  const done = nodes.filter((node) => node.status === "success").length;

  return (
    <div className="coding-doc">
      <header>
        <div>
          <h1>{task.name}</h1>
          <p>{task.requirement}</p>
        </div>
      </header>

      <div className="coding-doc__stats">
        <span>
          阶段 <b>{phase.label}</b>
        </span>
        {nodes.length > 0 && (
          <span>
            子任务{" "}
            <b>
              {done}/{nodes.length}
            </b>
          </span>
        )}
        <span>
          变更 <b>{changedFileCount}</b>
        </span>
        <span>
          问题 <b>{problemCount}</b>
        </span>
        <span>
          执行引擎 <b>{task.planRevision ? "结构化 DAG" : "直接任务"}</b>
        </span>
        {repairRounds.length > 0 && (
          <span>
            修复轮次{" "}
            <b>
              {repairRounds.length}/{maxRepairRounds}
            </b>
          </span>
        )}
      </div>

      {task.planIssues.length > 0 && (
        <div className="coding-doc__note is-warning" role="status">
          <AlertTriangle size={12} />
          <div>
            {task.planIssues.map((issue) => (
              <p key={`${issue.code}:${issue.nodeKeys.join(",")}`}>{issue.message}</p>
            ))}
          </div>
        </div>
      )}

      <section>
        <h2>任务拆解</h2>
        {nodes.length === 0 ? (
          <p className="coding-doc__muted">Agent 尚未生成执行计划。</p>
        ) : (
          <div className="coding-dag">
            {nodes.map((node) => (
              <NodeRow key={node.id} node={node} onOpenFile={onOpenFile} />
            ))}
          </div>
        )}
      </section>

      <section>
        <h2>任务目标</h2>
        {task.acceptanceCriteria.length === 0 ? (
          <p className="coding-doc__muted">尚未生成验收标准。</p>
        ) : (
          <ul className="coding-dag__criteria">
            {task.acceptanceCriteria.map((criterion) => (
              <li key={criterion.id} className={criterion.satisfied ? "is-met" : ""}>
                {criterion.satisfied ? <CheckCircle2 size={12} /> : <MinusCircle size={12} />}
                {criterion.content}
              </li>
            ))}
          </ul>
        )}
      </section>

      {ledger.length > 0 && (
        <section>
          <h2>执行记录</h2>
          <ol className="coding-dag__ledger">
            {ledger.slice(-12).reverse().map((event) => (
              <li key={event.id}>
                <time dateTime={event.createdAt}>
                  {new Date(event.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </time>
                {event.nodeKey && <b>{event.nodeKey}</b>}
                <span>{event.message}</span>
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}
