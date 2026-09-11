import { create } from "zustand";

import { codingApi } from "../lib/tauri-api";
import type {
  ChangeSet,
  CodingTask,
  OrchestratorState,
  Problem,
  TaskSummary,
  VerificationRecord,
} from "../lib/types";

/**
 * Read-only mirror of the backend's task state.
 *
 * The Rust side owns every value here; this store only caches what the UI last
 * heard so React can render it. Nothing in this file may decide a phase or a
 * verdict — that authority stays in the orchestrator.
 */
interface TaskState {
  root: string;
  summaries: TaskSummary[];
  task: CodingTask | null;
  changeSet: ChangeSet | null;
  verifications: VerificationRecord[];
  problems: Problem[];
  orchestrator: OrchestratorState | null;
  loading: boolean;
  error: string | null;

  setRoot: (root: string) => void;
  refreshSummaries: () => Promise<void>;
  selectTask: (taskId: string) => Promise<void>;
  createTask: (name: string, requirement: string) => Promise<CodingTask | null>;
  renameTask: (taskId: string, name: string) => Promise<void>;
  deleteTask: (taskId: string) => Promise<void>;
  refreshTaskState: () => Promise<void>;
  applyPhase: (taskId: string, phase: CodingTask["phase"]) => void;
  applyVerification: (record: VerificationRecord) => void;
  reset: () => void;
}

function message(error: unknown): string {
  return String(error).replace(/^Error:\s*/, "");
}

export const useTaskStore = create<TaskState>((set, get) => ({
  root: "",
  summaries: [],
  task: null,
  changeSet: null,
  verifications: [],
  problems: [],
  orchestrator: null,
  loading: false,
  error: null,

  setRoot: (root) => {
    if (get().root === root) return;
    set({
      root,
      summaries: [],
      task: null,
      changeSet: null,
      verifications: [],
      problems: [],
      orchestrator: null,
      error: null,
    });
  },

  refreshSummaries: async () => {
    const { root } = get();
    if (!root) return;
    try {
      set({ summaries: await codingApi.listTasks(root), error: null });
    } catch (error) {
      set({ error: message(error) });
    }
  },

  selectTask: async (taskId) => {
    const { root } = get();
    if (!root) return;
    set({ loading: true });
    try {
      const task = await codingApi.getTask(root, taskId);
      set({ task, error: null });
      await get().refreshTaskState();
    } catch (error) {
      set({ error: message(error) });
    } finally {
      set({ loading: false });
    }
  },

  createTask: async (name, requirement) => {
    const { root } = get();
    if (!root) return null;
    try {
      const task = await codingApi.createTask(root, name, requirement);
      set({ task, changeSet: null, verifications: [], problems: [], error: null });
      await get().refreshSummaries();
      return task;
    } catch (error) {
      set({ error: message(error) });
      return null;
    }
  },

  renameTask: async (taskId, name) => {
    const { root } = get();
    if (!root) return;
    try {
      const task = await codingApi.renameTask(root, taskId, name);
      set((state) => ({ task: state.task?.id === taskId ? task : state.task }));
      await get().refreshSummaries();
    } catch (error) {
      set({ error: message(error) });
    }
  },

  deleteTask: async (taskId) => {
    const { root } = get();
    if (!root) return;
    try {
      await codingApi.deleteTask(root, taskId);
      set((state) => (state.task?.id === taskId ? { ...state, task: null } : state));
      await get().refreshSummaries();
    } catch (error) {
      set({ error: message(error) });
    }
  },

  refreshTaskState: async () => {
    const { root, task } = get();
    if (!root || !task) return;
    try {
      const [changeSet, verifications, problems, orchestrator] = await Promise.all([
        codingApi.getChangeSet(root, task.id),
        codingApi.listVerifications(root, task.id),
        codingApi.listProblems(root, task.id),
        codingApi.orchestratorState(root, task.id),
      ]);
      set({
        changeSet,
        verifications,
        problems,
        orchestrator,
        // The orchestrator's copy is authoritative for phase and criteria.
        task: orchestrator.task,
        error: null,
      });
    } catch (error) {
      set({ error: message(error) });
    }
  },

  applyPhase: (taskId, phase) =>
    set((state) => ({
      task: state.task?.id === taskId ? { ...state.task, phase } : state.task,
      summaries: state.summaries.map((entry) =>
        entry.id === taskId ? { ...entry, phase } : entry,
      ),
    })),

  applyVerification: (record) =>
    set((state) => {
      if (state.task?.id !== record.taskId) return state;
      return { verifications: [...state.verifications, record] };
    }),

  reset: () =>
    set({
      summaries: [],
      task: null,
      changeSet: null,
      verifications: [],
      problems: [],
      orchestrator: null,
      error: null,
    }),
}));
