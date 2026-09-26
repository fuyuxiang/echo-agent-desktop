import { useSyncExternalStore } from "react";

// Revisions belong to this renderer's pending submissions. Persisted text and
// attachment formats stay compatible with existing backups; no request can
// survive a renderer restart. Never reuse a revision after clearing a draft.
const revisions = new Map<string, number>();
const listeners = new Set<() => void>();
let sequence = 0;

export function draftRevision(scope: string): number {
  return revisions.get(scope) ?? 0;
}

export function touchDraft(scope: string): void {
  revisions.set(scope, ++sequence);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useDraftRevision(scope: string | undefined): number {
  return useSyncExternalStore(subscribe, () => scope === undefined ? 0 : draftRevision(scope));
}
