/**
 * Mirrors the Rust types in `src-tauri/src/coding/`. Struct fields arrive as
 * camelCase and enum values as snake_case, matching the serde attributes there.
 */

export type TaskPhase =
  | "idle"
  | "analyzing"
  | "planning"
  | "implementing"
  | "verifying"
  | "diagnosing"
  | "repairing"
  | "gating"
  | "delivered"
  | "blocked";

/**
 * The user's intent for a coding task. This is deliberately independent from
 * the permission policy: mode controls what the Agent should do, while the
 * permission policy controls which actions need approval.
 */
export type CodingMode = "ask" | "plan" | "agent";

export type TaskNodeStatus = "pending" | "running" | "success" | "failed" | "blocked";

export interface AcceptanceCriterion {
  id: string;
  content: string;
  satisfied: boolean;
  evidence: string[];
}

export interface TaskNode {
  id: string;
  content: string;
  dependencies: string[];
  relatedFiles: string[];
  status: TaskNodeStatus;
  priority: string;
}

export interface CodingTask {
  id: string;
  name: string;
  requirement: string;
  phase: TaskPhase;
  phaseReason?: string | null;
  blocker?: string | null;
  acceptanceCriteria: AcceptanceCriterion[];
  taskNodes: TaskNode[];
  /** Missing only on tasks persisted by releases before work modes existed. */
  mode?: CodingMode | null;
  planRequired: boolean;
  /** Stop after automated checks so the user can review every changed file. */
  reviewRequired: boolean;
  modelId?: string | null;
  sessionId?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Infer a safe mode for tasks created before `mode` was persisted. */
export function codingModeForTask(
  task: Pick<CodingTask, "mode" | "planRequired" | "phase">,
): CodingMode {
  if (task.mode) return task.mode;
  return task.planRequired && task.phase === "planning" ? "plan" : "agent";
}

export interface TaskSummary {
  id: string;
  name: string;
  phase: TaskPhase;
  updatedAt: string;
}

export type ChangeKind = "added" | "modified" | "deleted" | "renamed";

export interface FileChange {
  path: string;
  kind: ChangeKind;
  added: number;
  removed: number;
  baselineContent?: string | null;
  preExisting: boolean;
}

export interface ChangeSet {
  taskId: string;
  baselineMode?: "git" | "filesystem" | null;
  /** Legacy backend fields; current IPC intentionally omits internal baselines. */
  baselineFiles?: string[];
  baselineHead?: string | null;
  baselineEntries?: Array<{
    path: string;
    existed: boolean;
    contentBase64?: string | null;
    hash?: string | null;
  }>;
  changes: FileChange[];
  createdAt: string;
  reviewedFiles: string[];
  reviewedHashes?: Record<string, string>;
  changeHashes?: Record<string, string>;
  rollbackUnsafeFiles?: string[];
  committedHash?: string | null;
}

export interface ChangeDiff {
  original: string;
  modified: string;
  binary: boolean;
}

export type VerificationKind = "build" | "lint" | "type_check" | "test" | "custom";
export type VerificationStatus = "running" | "passed" | "failed" | "timed_out" | "cancelled";

export interface TestSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
}

export interface DetectedCommand {
  kind: VerificationKind;
  command: string;
  label: string;
}

export interface VerificationRecord {
  id: string;
  taskId: string;
  kind: VerificationKind;
  command: string;
  status: VerificationStatus;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  startedAt: string;
  finishedAt: string;
  testSummary?: TestSummary | null;
  /** False when the runner output could not be parsed into a summary. */
  structured: boolean;
}

export type ProblemKind =
  | "compile"
  | "syntax"
  | "type"
  | "lint"
  | "test_failure"
  | "runtime"
  | "dependency"
  | "configuration";

export type ProblemSeverity = "error" | "warning";

export interface Problem {
  id: string;
  kind: ProblemKind;
  severity: ProblemSeverity;
  message: string;
  file?: string | null;
  line?: number | null;
  column?: number | null;
  symbol?: string | null;
  sourceCommand: string;
  /** Stable across repair rounds; used to detect loops and regressions. */
  fingerprint: string;
}

export type RepairOutcome = "fixed" | "same_errors" | "new_errors" | "rounds_exhausted";

export interface RepairRound {
  round: number;
  problemFingerprints: string[];
  startedAt: string;
  outcome?: RepairOutcome | null;
}

export interface OrchestratorState {
  task: CodingTask;
  problems: Problem[];
  repairRounds: RepairRound[];
  changedFileCount: number;
  maxRepairRounds: number;
}

export type GateId =
  | "build"
  | "test"
  | "lint"
  | "type_check"
  | "verification_freshness"
  | "diff_review"
  | "acceptance";
export type GateStatus = "satisfied" | "not_satisfied" | "not_applicable";

export interface QualityGate {
  id: GateId;
  title: string;
  status: GateStatus;
  summary: string;
  evidence: string[];
}

export interface EvidenceEntry {
  criterionId: string;
  kind: string;
  detail: string;
  source: string;
}

export interface DeliveryReport {
  task: CodingTask;
  gates: QualityGate[];
  changes: FileChange[];
  totalAdded: number;
  totalRemoved: number;
  verifications: VerificationRecord[];
  problems: Problem[];
  repairRounds: RepairRound[];
  evidence: EvidenceEntry[];
  blockers: string[];
  /** True only when no gate is `not_satisfied`. */
  deliverable: boolean;
}

/** Payload of `coding://task-phase-changed`. */
export interface PhaseChangedEvent {
  root: string;
  taskId: string;
  phase: TaskPhase;
  reason: string;
  blocker?: string | null;
}

/** Payload of `coding://verification-output`. */
export interface VerificationOutputEvent {
  root: string;
  taskId: string;
  runId: string;
  stream: "stdout" | "stderr";
  chunk: string;
}

/** Payload of `coding://analysis-progress`. */
export interface AnalysisProgressEvent {
  root: string;
  scanned: number;
}

// ---- Phase 2: cross-file symbol index ----

export type SymbolKind =
  | "function"
  | "class"
  | "method"
  | "constant"
  | "type"
  | "interface"
  | "enum"
  | "module"
  | "variable";

export interface SymbolRecord {
  id: string;
  name: string;
  kind: SymbolKind;
  container: string | null;
  file: string;
  line: number;
  column: number;
  signature: string | null;
  exported: boolean;
}

export interface SymbolQueryHit {
  symbol: SymbolRecord;
  score: number;
}

export type IndexState =
  | "empty"
  | "building"
  | "ready"
  | "rebuilding"
  | "stale";

export interface IndexStatus {
  state: IndexState;
  filesIndexed: number;
  symbols: number;
  lastReconciledAt: string | null;
  inProgress: boolean;
}

/** Payload of `coding://index-progress`. */
export interface IndexProgressEvent {
  root: string;
  scanned: number;
  totalEstimate: number;
}

/** Payload of `coding://index-updated`. */
export interface IndexUpdatedEvent {
  root: string;
  file: string;
  added: number;
  updated: number;
  removed: number;
}

/** Payload of `coding://index-removed`. */
export interface IndexRemovedEvent {
  root: string;
  file: string;
}

/** Payload of workspace file events used to keep open editor tabs current. */
export interface WorkspaceFileEvent {
  root: string;
  file: string;
}

// ---- Phase 2: cross-file references + impact ----

export type ReferenceKind =
  | "definition"
  | "read"
  | "write"
  | "call"
  | "import"
  | "type"
  | "unknown";

export interface ReferenceRecord {
  symbol: string;
  file: string;
  line: number;
  column: number;
  kind: ReferenceKind;
  preview: string;
}

export interface ReferenceHit {
  reference: ReferenceRecord;
  enclosingSymbol: SymbolRecord | null;
}

export interface ImpactNode {
  symbol: SymbolRecord;
  references: number;
  tests: number;
  depth: number;
}

export interface ImpactEdge {
  fromFile: string;
  fromLine: number;
  to: string;
  kind: ReferenceKind;
}

export interface ImpactGraph {
  target: string;
  direct: ImpactNode[];
  transitive: ImpactNode[];
  testImpact: SymbolRecord[];
  edges: ImpactEdge[];
  depthUsed: number;
}
