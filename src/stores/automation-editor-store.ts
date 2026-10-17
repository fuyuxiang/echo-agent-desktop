import { create } from "zustand";
import type { Automation, AutomationStatus } from "@/lib/types";
import { draftFromAutomation, type AutomationDraft } from "@/components/automation/schedule-utils";

type DraftUpdate = AutomationDraft | null | ((draft: AutomationDraft | null) => AutomationDraft | null);
interface AutomationEditorState {
  draft: AutomationDraft | null;
  initialDraft: AutomationDraft | null;
  editingAutomation: Automation | null;
  isCreating: boolean;
  visible: boolean;
  operation: "saving" | "deleting" | null;
  generation: number;
  begin: (draft: AutomationDraft, automation?: Automation) => void;
  setDraft: (update: DraftUpdate) => void;
  suspend: () => void;
  resume: () => void;
  startOperation: (operation: "saving" | "deleting", generation: number) => boolean;
  finishOperation: (generation: number) => void;
  markSaved: (automation: Automation, submitted: AutomationDraft, generation: number) => void;
  syncStatus: (status: AutomationStatus, generation: number) => void;
  convertToNew: () => void;
  close: (generation?: number) => void;
}

// The automation editor belongs to the application, rather than a navigation
// page. Leaving the panel retains its input, but does not create or save a job.
export const useAutomationEditorStore = create<AutomationEditorState>((set, get) => ({
  draft: null, initialDraft: null, editingAutomation: null, isCreating: false, visible: false, operation: null, generation: 0,
  begin: (draft, automation) => set((state) => ({
    draft, initialDraft: structuredClone(draft), editingAutomation: automation ?? null,
    isCreating: !automation, visible: true, operation: null, generation: state.generation + 1,
  })),
  setDraft: (update) => set((state) => ({ draft: typeof update === "function" ? update(state.draft) : update })),
  suspend: () => set({ visible: false }),
  resume: () => set((state) => ({ visible: state.draft !== null })),
  startOperation: (operation, generation) => {
    const state = get();
    if (!state.draft || state.generation !== generation || state.operation) return false;
    set({ operation });
    return true;
  },
  finishOperation: (generation) => set((state) => state.generation !== generation ? state : { operation: null }),
  markSaved: (automation, submitted, generation) => set((state) => {
    if (state.generation !== generation) return state;
    const saved = draftFromAutomation(automation);
    return {
      initialDraft: structuredClone(saved), editingAutomation: automation, isCreating: false,
      // Preserve any newer input even if a caller updated it during IPC.
      draft: state.draft === submitted ? saved : state.draft,
    };
  }),
  syncStatus: (status, generation) => set((state) => state.generation !== generation ? state : {
    draft: state.draft && { ...state.draft, status },
    initialDraft: state.initialDraft && { ...state.initialDraft, status },
    editingAutomation: state.editingAutomation && { ...state.editingAutomation, status },
  }),
  convertToNew: () => set((state) => !state.draft || state.operation ? state : {
    draft: { ...state.draft, id: "" },
    initialDraft: state.initialDraft && { ...state.initialDraft, id: "" },
    editingAutomation: null, isCreating: true, visible: true, generation: state.generation + 1,
  }),
  close: (generation) => set((state) => generation !== undefined && generation !== state.generation ? state : {
    draft: null, initialDraft: null, editingAutomation: null, isCreating: false, visible: false, operation: null, generation: state.generation + 1,
  }),
}));

export function automationEditorDirty(state = useAutomationEditorStore.getState()): boolean {
  return state.draft !== null && JSON.stringify(state.draft) !== JSON.stringify(state.initialDraft);
}

/** Keep the draft until the process actually exits, including failed exits. */
export async function confirmAutomationEditorExit(confirmDiscard: () => Promise<boolean>): Promise<void> {
  const editor = useAutomationEditorStore.getState();
  if (editor.operation) throw new Error(`自动化任务正在${editor.operation === "deleting" ? "删除" : "保存"}，请稍候再退出。`);
  if (!automationEditorDirty(editor)) return;
  if (!await confirmDiscard()) throw new Error("退出已取消，自动化草稿已保留。");
  const current = useAutomationEditorStore.getState();
  if (current.generation !== editor.generation || current.draft !== editor.draft || current.operation) {
    throw new Error("自动化草稿已变化，请确认最新内容后重试退出。");
  }
}
