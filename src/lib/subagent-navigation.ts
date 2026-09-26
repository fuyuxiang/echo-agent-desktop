/** The exact place from which a child session was opened. */
export interface SubagentReturnPoint {
  parentSessionId: string;
  parentCwd?: string;
  childSessionId: string;
  subagentKey: string;
  scrollTop: number;
  /** Row position relative to the transcript viewport, not the whole page. */
  rowOffset: number;
}

export interface SubagentOpenContext extends Omit<SubagentReturnPoint, "childSessionId"> {}

export interface SubagentScrollRestore extends SubagentReturnPoint {
  sequence: number;
}

/** A new root replaces stale history; a nested child extends the current chain. */
export function pushSubagentReturnPoint(
  trail: SubagentReturnPoint[],
  point: SubagentReturnPoint,
): SubagentReturnPoint[] {
  return trail[trail.length - 1]?.childSessionId === point.parentSessionId
    ? [...trail, point]
    : [point];
}

export function activeSubagentReturnPoint(
  trail: SubagentReturnPoint[],
  sessionId: string | null,
): SubagentReturnPoint | null {
  const last = trail[trail.length - 1];
  return last?.childSessionId === sessionId ? last : null;
}

export function popSubagentReturnPoint(
  trail: SubagentReturnPoint[],
  point: SubagentReturnPoint,
): SubagentReturnPoint[] {
  return trail[trail.length - 1] === point ? trail.slice(0, -1) : trail;
}
