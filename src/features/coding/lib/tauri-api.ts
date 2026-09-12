/**
 * Thin wrappers over the coding workbench Tauri commands. Kept free of React so
 * both components and plain logic can call them, and so the backend contract
 * lives in exactly one place.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type {
  AnalysisProgressEvent,
  ChangeSet,
  ChangeDiff,
  CodingTask,
  DeliveryReport,
  DetectedCommand,
  FileChange,
  ImpactGraph,
  IndexProgressEvent,
  IndexRemovedEvent,
  IndexStatus,
  IndexUpdatedEvent,
  OrchestratorState,
  PhaseChangedEvent,
  Problem,
  ReferenceHit,
  SymbolQueryHit,
  SymbolRecord,
  TaskSummary,
  VerificationKind,
  VerificationOutputEvent,
  VerificationRecord,
} from "./types";

export const codingApi = {
  listTasks: (root: string) => invoke<TaskSummary[]>("coding_task_list", { root }),
  createTask: (root: string, name: string, requirement: string) =>
    invoke<CodingTask>("coding_task_create", { root, name, requirement }),
  getTask: (root: string, taskId: string) =>
    invoke<CodingTask | null>("coding_task_get", { root, taskId }),
  deleteTask: (root: string, taskId: string) =>
    invoke<void>("coding_task_delete", { root, taskId }),
  renameTask: (root: string, taskId: string, name: string) =>
    invoke<CodingTask>("coding_task_rename", { root, taskId, name }),
  bindTaskRuntime: (root: string, taskId: string, sessionId: string, modelId: string) =>
    invoke<CodingTask>("coding_task_bind_runtime", { root, taskId, sessionId, modelId }),

  submitRequirement: (root: string, taskId: string, planRequired: boolean) =>
    invoke<CodingTask>("coding_task_submit_requirement", { root, taskId, planRequired }),
  approvePlan: (root: string, taskId: string) =>
    invoke<CodingTask>("coding_task_approve_plan", { root, taskId }),
  resolvePlan: (
    root: string,
    taskId: string,
    outcome: "approved" | "cancelled" | "abandoned",
    planEntries: string[],
  ) => invoke<CodingTask>("coding_task_resolve_plan", { root, taskId, outcome, planEntries }),
  reportStartFailed: (root: string, taskId: string, reason: string) =>
    invoke<CodingTask>("coding_task_report_start_failed", { root, taskId, reason }),
  beginFollowup: (root: string, taskId: string) =>
    invoke<CodingTask>("coding_task_begin_followup", { root, taskId }),
  beginVerification: (root: string, taskId: string) =>
    invoke<CodingTask>("coding_task_begin_verification", { root, taskId }),
  rollbackTask: (root: string, taskId: string) =>
    invoke<string[]>("coding_task_rollback", { root, taskId }),

  getChangeSet: (root: string, taskId: string) =>
    invoke<ChangeSet>("coding_changeset_get", { root, taskId }),
  captureBaseline: (root: string, taskId: string, dirtyFiles: string[]) =>
    invoke<ChangeSet>("coding_changeset_capture_baseline", { root, taskId, dirtyFiles }),
  changeDiff: (root: string, taskId: string, path: string) =>
    invoke<ChangeDiff>("coding_changeset_diff", { root, taskId, path }),
  recordChange: (root: string, taskId: string, change: FileChange) =>
    invoke<ChangeSet>("coding_changeset_record_change", { root, taskId, change }),
  discardFile: (root: string, taskId: string, path: string) =>
    invoke<ChangeSet>("coding_changeset_discard_file", { root, taskId, path }),
  markReviewed: (root: string, taskId: string, path: string) =>
    invoke<ChangeSet>("coding_changeset_mark_reviewed", { root, taskId, path }),
  syncFromGit: (root: string, taskId: string) =>
    invoke<ChangeSet>("coding_changeset_sync_from_git", { root, taskId }),

  detectCommands: (root: string) =>
    invoke<DetectedCommand[]>("coding_verification_detect", { root }),
  listVerifications: (root: string, taskId: string) =>
    invoke<VerificationRecord[]>("coding_verification_list", { root, taskId }),
  runVerification: (
    root: string,
    taskId: string,
    kind: VerificationKind,
    command: string,
    timeoutSecs?: number,
    requestedRunId?: string,
  ) =>
    invoke<VerificationRecord>("coding_verification_run", {
      root,
      taskId,
      kind,
      command,
      timeoutSecs: timeoutSecs ?? null,
      requestedRunId: requestedRunId ?? null,
    }),
  cancelVerification: (runId: string) => invoke<void>("coding_verification_cancel", { runId }),

  listProblems: (root: string, taskId: string) =>
    invoke<Problem[]>("coding_diagnostics_list", { root, taskId }),

  reportImplementation: (root: string, taskId: string) =>
    invoke<CodingTask>("coding_orchestrator_report_implementation", { root, taskId }),
  reportVerification: (root: string, taskId: string) =>
    invoke<CodingTask>("coding_orchestrator_report_verification", { root, taskId }),
  orchestratorState: (root: string, taskId: string) =>
    invoke<OrchestratorState>("coding_orchestrator_state", { root, taskId }),

  deliveryReport: (root: string, taskId: string) =>
    invoke<DeliveryReport>("coding_delivery_report", { root, taskId }),
  finalizeDelivery: (root: string, taskId: string) =>
    invoke<DeliveryReport>("coding_delivery_finalize", { root, taskId }),
  commitInput: (root: string, taskId: string) =>
    invoke<string>("coding_delivery_commit_input", { root, taskId }),
  prInput: (root: string, taskId: string) =>
    invoke<DeliveryReport>("coding_delivery_pr_input", { root, taskId }),
  commit: (root: string, taskId: string, message: string) =>
    invoke<string>("coding_git_commit", { root, taskId, message }),

  // Phase 2: cross-file symbol index + reference search + impact analysis.
  indexStatus: (root: string) => invoke<IndexStatus>("coding_index_status", { root }),
  indexBootstrap: (root: string) => invoke<IndexStatus>("coding_index_bootstrap", { root }),
  indexRebuild: (root: string) => invoke<IndexStatus>("coding_index_rebuild", { root }),
  symbolQuery: (root: string, needle: string, kind?: string, limit?: number) =>
    invoke<SymbolQueryHit[]>("coding_symbol_query", {
      root,
      needle,
      kind: kind ?? null,
      limit: limit ?? null,
    }),
  symbolAt: (root: string, file: string, line: number) =>
    invoke<SymbolRecord | null>("coding_symbol_at", { root, file, line }),

  refsFind: (root: string, symbol: string, includeDeclarations?: boolean) =>
    invoke<ReferenceHit[]>("coding_refs_find", {
      root,
      symbol,
      includeDeclarations: includeDeclarations ?? null,
    }),
  refsDefinition: (root: string, symbol: string) =>
    invoke<ReferenceHit[]>("coding_refs_definition", { root, symbol }),
  impactAnalyze: (root: string, target: string, depth?: number, includeTests?: boolean) =>
    invoke<ImpactGraph>("coding_impact_analyze", {
      root,
      target,
      depth: depth ?? null,
      includeTests: includeTests ?? null,
    }),
  createEntry: (root: string, parent: string | undefined, name: string, directory: boolean) =>
    invoke<string>("coding_create_entry", {
      request: { root, parent: parent ?? null, name, directory },
    }),
};

export function onPhaseChanged(callback: (event: PhaseChangedEvent) => void): Promise<UnlistenFn> {
  return listen<PhaseChangedEvent>("coding://task-phase-changed", (event) => callback(event.payload));
}

export function onVerificationUpdated(
  callback: (record: VerificationRecord) => void,
): Promise<UnlistenFn> {
  return listen<VerificationRecord>("coding://verification-updated", (event) =>
    callback(event.payload),
  );
}

export function onVerificationOutput(
  callback: (event: VerificationOutputEvent) => void,
): Promise<UnlistenFn> {
  return listen<VerificationOutputEvent>("coding://verification-output", (event) =>
    callback(event.payload),
  );
}

export function onAnalysisProgress(
  callback: (event: AnalysisProgressEvent) => void,
): Promise<UnlistenFn> {
  return listen<AnalysisProgressEvent>("coding://analysis-progress", (event) =>
    callback(event.payload),
  );
}

export function onIndexProgress(
  callback: (event: IndexProgressEvent) => void,
): Promise<UnlistenFn> {
  return listen<IndexProgressEvent>("coding://index-progress", (event) =>
    callback(event.payload),
  );
}

export function onIndexUpdated(
  callback: (event: IndexUpdatedEvent) => void,
): Promise<UnlistenFn> {
  return listen<IndexUpdatedEvent>("coding://index-updated", (event) =>
    callback(event.payload),
  );
}

export function onIndexRemoved(
  callback: (event: IndexRemovedEvent) => void,
): Promise<UnlistenFn> {
  return listen<IndexRemovedEvent>("coding://index-removed", (event) =>
    callback(event.payload),
  );
}
