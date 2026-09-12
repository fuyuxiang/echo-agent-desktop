import { useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  CircleSlash,
  ClipboardCopy,
  LoaderCircle,
  MinusCircle,
} from "lucide-react";

import { codingApi } from "../../lib/tauri-api";
import type { DeliveryReport, GateStatus, QualityGate } from "../../lib/types";

interface DeliveryReportTabProps {
  root: string;
  taskId: string | null;
  /** Bumped by the workbench to force a reload after a run finishes. */
  revision?: number;
  onOpenFile: (path: string) => void;
  onToast?: (message: string) => void;
}

function GateIcon({ status }: { status: GateStatus }) {
  if (status === "satisfied") return <CheckCircle2 size={14} />;
  if (status === "not_satisfied") return <AlertTriangle size={14} />;
  return <MinusCircle size={14} />;
}

const GATE_STATUS_TEXT: Record<GateStatus, string> = {
  satisfied: "已满足",
  not_satisfied: "未满足",
  not_applicable: "不适用",
};

/** Render one gate with the evidence the backend based its verdict on. */
function GateRow({ gate }: { gate: QualityGate }) {
  const [open, setOpen] = useState(gate.status === "not_satisfied");
  return (
    <div className={`coding-report__gate is-${gate.status}`}>
      <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <GateIcon status={gate.status} />
        <strong>{gate.title}</strong>
        <em>{GATE_STATUS_TEXT[gate.status]}</em>
        <span>{gate.summary}</span>
      </button>
      {open && gate.evidence.length > 0 && (
        <ul>
          {gate.evidence.map((entry, index) => (
            <li key={index}>{entry}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Delivery report: gates, changes, verifications, repair history and the
 * acceptance evidence chain.
 *
 * Everything here comes from the backend's own aggregation, so the report cannot
 * claim a task is deliverable when a gate says otherwise. A gate the project
 * cannot run shows as "不适用" rather than quietly passing.
 */
export function DeliveryReportTab({
  root,
  taskId,
  revision = 0,
  onOpenFile,
  onToast,
}: DeliveryReportTabProps) {
  const [report, setReport] = useState<DeliveryReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!root || !taskId) {
      setReport(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void codingApi
      .deliveryReport(root, taskId)
      .then((next) => {
        if (!cancelled) {
          setReport(next);
          setError(null);
        }
      })
      .catch((cause) => {
        if (!cancelled) setError(String(cause).replace(/^Error:\s*/, ""));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [revision, root, taskId]);

  const copyPrDescription = async () => {
    if (!report) return;
    const lines = [
      `## ${report.task.name}`,
      "",
      report.task.requirement,
      "",
      `### 变更（+${report.totalAdded} -${report.totalRemoved}）`,
      ...report.changes.map(
        (change) => `- ${change.path} (+${change.added} -${change.removed})${
          change.preExisting ? "（任务开始时已修改，需手动整理提交）" : ""
        }`,
      ),
      "",
      "### 验证",
      ...report.verifications.map(
        (record) => `- ${record.command}：${record.status}（退出码 ${record.exitCode ?? "无"}）`,
      ),
      "",
      "### 质量门禁",
      ...report.gates.map((gate) => `- ${gate.title}：${GATE_STATUS_TEXT[gate.status]} — ${gate.summary}`),
    ];
    if (report.blockers.length > 0) {
      lines.push("", "### 未解决问题", ...report.blockers.map((entry) => `- ${entry}`));
    }
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      onToast?.("PR 描述已复制");
    } catch {
      onToast?.("复制失败，请手动选择内容");
    }
  };

  if (!taskId) {
    return <div className="coding-doc__empty">新建开发任务后即可生成交付报告。</div>;
  }
  if (loading && !report) {
    return (
      <div className="coding-doc__empty">
        <LoaderCircle size={15} className="is-spinning" />
        正在汇总交付证据…
      </div>
    );
  }
  if (error) {
    return (
      <div className="coding-doc__empty is-error">
        <AlertTriangle size={15} />
        {error}
      </div>
    );
  }
  if (!report) return <div className="coding-doc__empty">暂无交付数据。</div>;

  const taskChanges = report.changes;

  return (
    <div className="coding-doc coding-report">
      <header>
        <div>
          <h1>{report.task.name}</h1>
          <p>{report.task.requirement}</p>
        </div>
        <div className="coding-doc__actions">
          <button type="button" onClick={() => void copyPrDescription()}>
            <ClipboardCopy size={12} /> 复制 PR 描述
          </button>
        </div>
      </header>

      <div className={`coding-report__verdict is-${report.deliverable ? "good" : "bad"}`}>
        {report.deliverable ? <CheckCircle2 size={15} /> : <CircleSlash size={15} />}
        <strong>{report.deliverable ? "满足交付条件" : "尚不满足交付条件"}</strong>
        <span>
          {report.deliverable
            ? "所有门禁均已满足或不适用。"
            : `${report.blockers.length} 项门禁未满足。`}
        </span>
      </div>

      {report.blockers.length > 0 && (
        <section>
          <h2>未解决问题</h2>
          <ul className="coding-report__blockers">
            {report.blockers.map((entry, index) => (
              <li key={index}>{entry}</li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h2>质量门禁</h2>
        <div className="coding-report__gates">
          {report.gates.map((gate) => (
            <GateRow key={gate.id} gate={gate} />
          ))}
        </div>
      </section>

      <section>
        <h2>
          文件变更 <small>+{report.totalAdded} / -{report.totalRemoved}</small>
        </h2>
        {taskChanges.length === 0 ? (
          <p className="coding-doc__muted">本任务没有产生代码变更。</p>
        ) : (
          <div className="coding-report__files">
            {taskChanges.map((change) => (
              <button key={change.path} type="button" onClick={() => onOpenFile(change.path)}>
                <em>{change.kind}</em>
                <span>{change.path}</span>
                <small>
                  +{change.added} -{change.removed}
                  {change.preExisting ? " · 起始时已修改" : ""}
                </small>
              </button>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2>验证结果</h2>
        {report.verifications.length === 0 ? (
          <p className="coding-doc__muted">尚未执行验证。</p>
        ) : (
          <table className="coding-report__table">
            <thead>
              <tr>
                <th>命令</th>
                <th>结果</th>
                <th>退出码</th>
                <th>用例</th>
              </tr>
            </thead>
            <tbody>
              {report.verifications.map((record) => (
                <tr key={record.id}>
                  <td>
                    <code>{record.command}</code>
                  </td>
                  <td>{record.status === "passed" ? "通过" : record.status === "failed" ? "失败" : record.status === "timed_out" ? "超时" : record.status === "cancelled" ? "已取消" : "执行中"}</td>
                  <td>{record.exitCode ?? "无"}</td>
                  <td>
                    {record.testSummary
                      ? `${record.testSummary.passed}/${record.testSummary.total}`
                      : record.kind === "test"
                        ? "未结构化"
                        : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {report.repairRounds.length > 0 && (
        <section>
          <h2>自动修复过程</h2>
          <ol className="coding-report__repairs">
            {report.repairRounds.map((round) => (
              <li key={round.round}>
                第 {round.round} 轮 · {round.problemFingerprints.length} 个问题
                {round.outcome ? ` · ${round.outcome}` : ""}
              </li>
            ))}
          </ol>
        </section>
      )}

      <section>
        <h2>验收标准</h2>
        {report.task.acceptanceCriteria.length === 0 ? (
          <p className="coding-doc__muted">尚未生成验收标准。</p>
        ) : (
          <div className="coding-report__criteria">
            {report.task.acceptanceCriteria.map((criterion) => (
              <div key={criterion.id} className={criterion.satisfied ? "is-met" : "is-unmet"}>
                {criterion.satisfied ? <CheckCircle2 size={13} /> : <MinusCircle size={13} />}
                <div>
                  <strong>{criterion.content}</strong>
                  {criterion.evidence.length > 0 ? (
                    <ul>
                      {criterion.evidence.map((entry, index) => (
                        <li key={index}>{entry}</li>
                      ))}
                    </ul>
                  ) : (
                    <p className="coding-doc__muted">尚无验证证据</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
