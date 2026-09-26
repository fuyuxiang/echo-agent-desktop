import { describe, expect, it } from "vitest";
import {
  activeSubagentReturnPoint,
  popSubagentReturnPoint,
  pushSubagentReturnPoint,
  type SubagentReturnPoint,
} from "../subagent-navigation";

function point(parentSessionId: string, childSessionId: string): SubagentReturnPoint {
  return { parentSessionId, childSessionId, parentCwd: "/workspace", subagentKey: childSessionId,
    scrollTop: 360, rowOffset: 72 };
}

describe("subagent navigation trail", () => {
  it("supports nested children and returns one level at a time", () => {
    const parent = point("root", "child");
    const nested = point("child", "grandchild");
    const trail = pushSubagentReturnPoint(pushSubagentReturnPoint([], parent), nested);
    expect(activeSubagentReturnPoint(trail, "grandchild")).toBe(nested);
    const afterFirstReturn = popSubagentReturnPoint(trail, nested);
    expect(activeSubagentReturnPoint(afterFirstReturn, "child")).toBe(parent);
    expect(popSubagentReturnPoint(afterFirstReturn, parent)).toEqual([]);
  });

  it("does not offer a stale back route after an unrelated session selection", () => {
    const old = point("root", "child");
    expect(activeSubagentReturnPoint([old], "unrelated")).toBeNull();
    const next = point("other-root", "other-child");
    expect(pushSubagentReturnPoint([old], next)).toEqual([next]);
    expect(popSubagentReturnPoint([old], next)).toEqual([old]);
  });
});
