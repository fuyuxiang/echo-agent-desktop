import { useEffect, useState } from "react";
import { AlertTriangle, ClipboardList, LoaderCircle, ShieldCheck } from "lucide-react";

import { describeTaskProgress } from "../lib/phase";
import { codingApi } from "../lib/tauri-api";
import type { CodingTask, DeliveryReport } from "../lib/types";

interface TaskEvidenceStripProps {
  root: string;
  task: CodingTask;
  revision: number;
  needsInput: boolean;
  onOpenPlan: () => void;
  onOpenReport: () => void;
}

export function TaskEvidenceStrip({
  root,
  task,
  revision,
  needsInput,
  onOpenPlan,
  onOpenReport,
}: TaskEvidenceStripProps) {
  const [report, setReport] = useState<DeliveryReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setReport(null);
    setLoading(true);
    setError(false);
    void codingApi.deliveryReport(root, task.id)
      .then((next) => {
        if (!cancelled) setReport(next);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [root, task.id, task.updatedAt, revision]);

  const nodes = task.taskNodes;
  const done = nodes.filter((node) => node.status === "success").length;
  const active = nodes.find((node) => node.status === "running");
  const applicableGates = report?.gates.filter((gate) => gate.status !== "not_applicable") ?? [];
  const satisfiedGates = applicableGates.filter((gate) => gate.status === "satisfied").length;
  const failedGates = applicableGates.length - satisfiedGates;
  const phase = describeTaskProgress(task.phase);

  return (
    <div className="echo-theia-agent__evidence" aria-label="任务进度与交付检查">
      <div className="echo-theia-agent__evidence-current">
        <span className={`coding-agent__phase is-${phase.tone}`}>{needsInput ? "等待你处理" : phase.label}</span>
        <strong title={active?.content ?? task.name}>{active ? `${active.planKey} · ${active.content}` : task.name}</strong>
      </div>
      <div className="echo-theia-agent__evidence-actions">
        <button type="button" onClick={onOpenPlan} title="查看任务节点、依赖和执行记录">
          <ClipboardList size={13} /> 计划 {nodes.length > 0 ? `${done}/${nodes.length}` : ""}
        </button>
        <button type="button" onClick={onOpenReport} title="查看后端交付门禁和验证证据">
          {loading ? <LoaderCircle size={13} className="is-spinning" /> : error || failedGates > 0 ? <AlertTriangle size={13} /> : <ShieldCheck size={13} />}
          {loading ? "检查中" : error ? "检查不可用" : report ? `门禁 ${satisfiedGates}/${applicableGates.length}` : "暂无检查"}
        </button>
      </div>
    </div>
  );
}
