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
  CodingTask,
  DeliveryReport,
  DetectedCommand,
  FileChange,
  OrchestratorState,
  PhaseChangedEvent,
  Problem,
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

  submitRequirement: (root: string, taskId: string, planRequired: boolean) =>
    invoke<CodingTask>("coding_task_submit_requirement", { root, taskId, planRequired }),
  approvePlan: (root: string, taskId: string) =>
    invoke<CodingTask>("coding_task_approve_plan", { root, taskId }),
  rollbackTask: (root: string, taskId: string) =>
    invoke<string[]>("coding_task_rollback", { root, taskId }),

  getChangeSet: (root: string, taskId: string) =>
    invoke<ChangeSet>("coding_changeset_get", { root, taskId }),
  captureBaseline: (root: string, taskId: string, dirtyFiles: string[]) =>
    invoke<ChangeSet>("coding_changeset_capture_baseline", { root, taskId, dirtyFiles }),
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
  ) =>
    invoke<VerificationRecord>("coding_verification_run", {
      root,
      taskId,
      kind,
      command,
      timeoutSecs: timeoutSecs ?? null,
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
  commitInput: (root: string, taskId: string) =>
    invoke<string>("coding_delivery_commit_input", { root, taskId }),
  prInput: (root: string, taskId: string) =>
    invoke<DeliveryReport>("coding_delivery_pr_input", { root, taskId }),
  commit: (root: string, taskId: string, message: string) =>
    invoke<string>("coding_git_commit", { root, taskId, message }),
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
