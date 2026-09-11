import type { TaskPhase } from "./types";

export interface PhasePresentation {
  label: string;
  /** Rendering tone; the UI maps this to a colour token. */
  tone: "idle" | "running" | "waiting" | "good" | "bad";
  /** True while the workbench is actively working. */
  active: boolean;
}

const PHASES: Record<TaskPhase, PhasePresentation> = {
  idle: { label: "待开始", tone: "idle", active: false },
  planning: { label: "制定计划", tone: "running", active: true },
  implementing: { label: "实现中", tone: "running", active: true },
  verifying: { label: "验证中", tone: "running", active: true },
  diagnosing: { label: "诊断中", tone: "running", active: true },
  repairing: { label: "修复中", tone: "running", active: true },
  gating: { label: "质量门禁", tone: "running", active: true },
  delivered: { label: "已交付", tone: "good", active: false },
  blocked: { label: "已阻塞", tone: "bad", active: false },
};

export function describePhase(phase: TaskPhase): PhasePresentation {
  return PHASES[phase] ?? PHASES.idle;
}

/**
 * Short status line for the status bar: phase plus the counts that matter.
 * Deliberately terse — this is chrome, not a dashboard.
 */
export function statusSummary(options: {
  phase?: TaskPhase;
  changedFileCount: number;
  problemCount: number;
  repairRound?: number;
  maxRepairRounds?: number;
}): string {
  const parts: string[] = [];
  if (options.phase) parts.push(describePhase(options.phase).label);
  if (options.repairRound && options.repairRound > 0) {
    parts.push(`修复 ${options.repairRound}/${options.maxRepairRounds ?? 3}`);
  }
  if (options.changedFileCount > 0) parts.push(`${options.changedFileCount} 个变更`);
  if (options.problemCount > 0) parts.push(`${options.problemCount} 个问题`);
  return parts.join(" · ");
}

/** Whether a task in this phase should block a destructive action. */
export function isBusyPhase(phase?: TaskPhase): boolean {
  return phase ? describePhase(phase).active : false;
}
