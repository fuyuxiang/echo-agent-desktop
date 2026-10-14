import type { SessionSummary } from "./types";

/** Apply a native snapshot while retaining edits made during its IPC round trip. */
export function reconcileSessionCatalog(
  incoming: SessionSummary[],
  before: SessionSummary[],
  current: SessionSummary[],
): SessionSummary[] {
  const beforeById = new Map(before.map((entry) => [entry.sessionId, entry]));
  const currentById = new Map(current.map((entry) => [entry.sessionId, entry]));
  const merged = incoming.filter((entry) => !beforeById.has(entry.sessionId) || currentById.has(entry.sessionId))
    .map((entry) => {
      const previous = beforeById.get(entry.sessionId);
      const latest = currentById.get(entry.sessionId);
      if (!latest) return entry;
      if (!previous) return { ...entry, ...latest };
      const changed = Object.fromEntries(Object.entries(latest).filter(([key, value]) =>
        value !== previous[key as keyof SessionSummary]));
      return { ...entry, ...changed };
    });
  const included = new Set(merged.map((entry) => entry.sessionId));
  return [
    ...current.filter((entry) => !beforeById.has(entry.sessionId) && !included.has(entry.sessionId)),
    ...merged,
  ];
}
