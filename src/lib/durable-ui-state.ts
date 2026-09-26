import { create } from "zustand";

interface StorageHealth { errors: Record<string, string> }
export const useStorageHealth = create<StorageHealth>(() => ({ errors: {} }));
const unreadable = new Set<string>();

function problem(key: string, error: unknown) {
  useStorageHealth.setState((state) => ({ errors: { ...state.errors, [key]: String(error) } }));
}

/** Invalid data is retained for recovery; a failed read never authorizes overwrite. */
export function readDurable<T>(key: string, fallback: T, validate: (value: unknown) => value is T): T {
  if (typeof localStorage === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const envelope = JSON.parse(raw);
    if (envelope.version !== 1 || !validate(envelope.data)) throw new Error("保存的数据格式无法读取，请先导出备份");
    return envelope.data;
  } catch (error) {
    unreadable.add(key);
    problem(key, error);
    return fallback;
  }
}

export function writeDurable(key: string, data: unknown): boolean {
  if (typeof localStorage === "undefined") return false;
  try {
    if (unreadable.has(key)) throw new Error("原有数据不可读，已保留原始内容；请先备份并恢复数据");
    localStorage.setItem(key, JSON.stringify({ version: 1, data }));
    if (useStorageHealth.getState().errors[key]) {
      useStorageHealth.setState((state) => {
        const errors = { ...state.errors }; delete errors[key]; return { errors };
      });
    }
    return true;
  } catch (error) { problem(key, error); return false; }
}

export function isStringMap(value: unknown): value is Record<string, string> {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && Object.values(value).every((item) => typeof item === "string");
}
