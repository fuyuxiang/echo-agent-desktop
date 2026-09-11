import { AlertTriangle, CheckCircle2, Info } from "lucide-react";

import type { Problem, ProblemKind } from "../lib/types";

interface ProblemsViewProps {
  problems: Problem[];
  onOpenProblem: (problem: Problem) => void;
}

const KIND_LABELS: Record<ProblemKind, string> = {
  compile: "编译",
  syntax: "语法",
  type: "类型",
  lint: "规范",
  test_failure: "测试",
  runtime: "运行时",
  dependency: "依赖",
  configuration: "配置",
};

/**
 * Structured diagnostics from the backend parsers.
 *
 * Every row carries the kind the backend classified it as, so a dependency
 * failure is not presented as a compile error. Rows with a file are clickable and
 * jump to the exact line.
 */
export function ProblemsView({ problems, onOpenProblem }: ProblemsViewProps) {
  if (problems.length === 0) {
    return (
      <div className="coding-panel__empty">
        <CheckCircle2 size={18} />
        当前没有检测到问题
      </div>
    );
  }

  const errors = problems.filter((problem) => problem.severity === "error").length;
  const warnings = problems.length - errors;

  return (
    <div className="coding-panel">
      <div className="coding-panel__summary">
        <span>{errors} 个错误</span>
        <span>{warnings} 个警告</span>
      </div>
      <div className="coding-panel__list">
        {problems.map((problem) => (
          <button
            key={problem.id}
            type="button"
            className={`coding-problem is-${problem.severity}`}
            onClick={() => onOpenProblem(problem)}
            disabled={!problem.file}
            title={problem.file ? `${problem.file}:${problem.line ?? 1}` : undefined}
          >
            {problem.severity === "error" ? <AlertTriangle size={13} /> : <Info size={13} />}
            <em>{KIND_LABELS[problem.kind]}</em>
            <span>{problem.message}</span>
            {problem.symbol && <code>{problem.symbol}</code>}
            {problem.file && (
              <small>
                {problem.file.split("/").pop()}
                {problem.line ? `:${problem.line}` : ""}
              </small>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
