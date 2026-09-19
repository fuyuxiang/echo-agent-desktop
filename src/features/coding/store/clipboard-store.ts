import { create } from "zustand";

export type ClipboardMode = "copy" | "cut";

interface ClipboardState {
  mode: ClipboardMode;
  paths: string[];
  setCopy(paths: string[]): void;
  setCut(paths: string[]): void;
  clear(): void;
}

export const useClipboardStore = create<ClipboardState>((set) => ({
  mode: "copy",
  paths: [],
  setCopy: (paths) => set({ mode: "copy", paths }),
  setCut: (paths) => set({ mode: "cut", paths }),
  clear: () => set({ mode: "copy", paths: [] }),
}));
