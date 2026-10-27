import { useCallback, useEffect, useRef, useState } from "react";
import type { ToastAction } from "@/components/Toast";
import { toastMessage, type ToastMessageKind } from "./toast-message";

export interface ToastEntry {
  id: number;
  message: string;
  actions: ToastAction[];
  kind: ToastMessageKind;
  operationKey?: string;
}
type Clock = { timer?: ReturnType<typeof setTimeout>; remaining: number; started: number; paused: boolean };

/** Bound bursts, merge identical notices, and leave time to read or act. */
export function useToastQueue() {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const entries = useRef<ToastEntry[]>([]);
  const clocks = useRef(new Map<number, Clock>());
  const nextId = useRef(0);

  const dismissToast = useCallback((id: number) => {
    clearTimeout(clocks.current.get(id)?.timer);
    clocks.current.delete(id);
    entries.current = entries.current.filter(entry => entry.id !== id);
    setToasts(entries.current);
  }, []);

  const enqueueToast = useCallback((message: string, actions: ToastAction[] = [], durationMs?: number, kind: ToastMessageKind = "auto", operationKey?: string) => {
    if (!message.trim()) return;
    // Two identical "Archived / Undo" notices can belong to different tasks.
    // Only informational notices can safely be merged without an operation key.
    const duplicate = actions.length ? undefined : entries.current.find(entry => entry.message === message && entry.kind === kind && entry.operationKey === operationKey && entry.actions.length === 0);
    const id = duplicate?.id ?? ++nextId.current;
    const previous = clocks.current.get(id);
    clearTimeout(previous?.timer);
    const remaining = durationMs ?? (actions.length || toastMessage(message, kind).details ? 8000 : 4000);
    const clock: Clock = { remaining, started: Date.now(), paused: previous?.paused ?? false };
    if (!clock.paused) clock.timer = setTimeout(() => dismissToast(id), remaining);
    clocks.current.set(id, clock);
    entries.current = [...entries.current.filter(entry => entry.id !== id), { id, message, actions, kind, operationKey }];
    while (entries.current.length > 3) {
      const removed = entries.current.shift()!;
      clearTimeout(clocks.current.get(removed.id)?.timer);
      clocks.current.delete(removed.id);
    }
    setToasts(entries.current);
    return id;
  }, [dismissToast]);

  const pauseToast = useCallback((id: number, paused: boolean) => {
    const clock = clocks.current.get(id);
    if (!clock || clock.paused === paused) return;
    clock.paused = paused;
    if (paused) {
      clearTimeout(clock.timer);
      clock.remaining = Math.max(0, clock.remaining - (Date.now() - clock.started));
    } else {
      clock.started = Date.now();
      clock.timer = setTimeout(() => dismissToast(id), clock.remaining);
    }
  }, [dismissToast]);

  useEffect(() => () => {
    for (const clock of clocks.current.values()) clearTimeout(clock.timer);
    clocks.current.clear();
  }, []);

  return { toasts, enqueueToast, dismissToast, pauseToast };
}
