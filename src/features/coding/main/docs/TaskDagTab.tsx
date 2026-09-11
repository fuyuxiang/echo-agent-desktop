import { AlertTriangle, CheckCircle2, CircleDot, LoaderCircle, MinusCircle } from "lucide-react";

import { describePhase } from "../../lib/phase";
import type { CodingTask, RepairRound, TaskNode, TaskNodeStatus } from "../../lib/types";

interface TaskDagTabProps {
  task: CodingTask | null;
  repairRounds: RepairRound[];
  maxRepairRounds: number;
  changedFileCount: number;
  problemCount: number;
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
  return (
    <div className={`coding-dag__node is-${node.status}`}>
      <div className="coding-dag__node-head">
        <StatusIcon status={node.status} />
        <b>{node.id}</b>
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
        {repairRounds.length > 0 && (
          <span>
            修复轮次{" "}
            <b>
              {repairRounds.length}/{maxRepairRounds}
            </b>
          </span>
        )}
      </div>

      <section>
        <h2>任务拆解</h2>
        {nodes.length === 0 ? (
          <p className="coding-doc__muted">
            {task.planRequired
              ? "Agent 尚未提交计划。"
              : "本任务未启用先给计划，Agent 直接实现，因此没有子任务拆解。"}
          </p>
        ) : (
          <div className="coding-dag">
            {nodes.map((node) => (
              <NodeRow key={node.id} node={node} onOpenFile={onOpenFile} />
            ))}
          </div>
        )}
      </section>

      <section>
        <h2>验收标准</h2>
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
    </div>
  );
}
