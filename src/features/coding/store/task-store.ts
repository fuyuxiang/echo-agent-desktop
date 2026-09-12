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

let selectionGeneration = 0;
let stateGeneration = 0;

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
    selectionGeneration += 1;
    stateGeneration += 1;
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
      const summaries = await codingApi.listTasks(root);
      if (get().root === root) set({ summaries, error: null });
    } catch (error) {
      if (get().root === root) set({ error: message(error) });
    }
  },

  selectTask: async (taskId) => {
    const { root } = get();
    if (!root) return;
    const generation = ++selectionGeneration;
    stateGeneration += 1;
    set({ loading: true });
    try {
      const task = await codingApi.getTask(root, taskId);
      if (generation !== selectionGeneration || get().root !== root) return;
      set({ task, error: null });
      await get().refreshTaskState();
    } catch (error) {
      if (generation === selectionGeneration && get().root === root) {
        set({ error: message(error) });
      }
    } finally {
      if (generation === selectionGeneration && get().root === root) set({ loading: false });
    }
  },

  createTask: async (name, requirement) => {
    const { root } = get();
    if (!root) return null;
    try {
      const task = await codingApi.createTask(root, name, requirement);
      selectionGeneration += 1;
      stateGeneration += 1;
      if (get().root !== root) return null;
      set({
        task,
        changeSet: null,
        verifications: [],
        problems: [],
        orchestrator: null,
        error: null,
      });
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
      set((state) => (state.task?.id === taskId
        ? {
            ...state,
            task: null,
            changeSet: null,
            verifications: [],
            problems: [],
            orchestrator: null,
          }
        : state));
      await get().refreshSummaries();
    } catch (error) {
      set({ error: message(error) });
    }
  },

  refreshTaskState: async () => {
    const { root, task } = get();
    if (!root || !task) return;
    const generation = ++stateGeneration;
    const taskId = task.id;
    try {
      const [changeSet, verifications, problems, orchestrator] = await Promise.all([
        codingApi.getChangeSet(root, taskId),
        codingApi.listVerifications(root, taskId),
        codingApi.listProblems(root, taskId),
        codingApi.orchestratorState(root, taskId),
      ]);
      if (
        generation !== stateGeneration
        || get().root !== root
        || get().task?.id !== taskId
      ) return;
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
      if (
        generation === stateGeneration
        && get().root === root
        && get().task?.id === taskId
      ) set({ error: message(error) });
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
