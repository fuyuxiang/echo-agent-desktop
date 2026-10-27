import { describe, expect, it } from "vitest";
import { planRecoveryAttempt } from "../recovery-policy";

describe("automatic recovery budget", () => {
  it("backs off and stops a crash loop, while allowing later independent incidents", () => {
    const first = planRecoveryAttempt([], 1000)!;
    const second = planRecoveryAttempt([1000], 2000)!;
    const third = planRecoveryAttempt([1000, 2000], 4000)!;
    expect([first.attempt, second.attempt, third.attempt]).toEqual([1, 2, 3]);
    expect(first.delay).toBeLessThan(second.delay);
    expect(second.delay).toBeLessThan(third.delay);
    expect(planRecoveryAttempt([1000, 2000, 4000], 8000)).toBeNull();
    expect(planRecoveryAttempt([1000, 2000, 4000], 125000)?.attempt).toBe(1);
    expect(planRecoveryAttempt([999999], 1000)?.attempt).toBe(1);
  });
});
