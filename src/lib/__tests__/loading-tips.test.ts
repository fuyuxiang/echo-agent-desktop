import { describe, expect, it } from "vitest";
import {
  LOADING_TIPS,
  PLAYFUL_LOADING_TIPS,
  PRACTICAL_LOADING_TIPS,
  pickLoadingTip,
} from "../loading-tips";

describe("loading companion copy", () => {
  it("同时保留实用提示和适量趣味文案", () => {
    expect(PRACTICAL_LOADING_TIPS.length).toBeGreaterThanOrEqual(8);
    expect(PLAYFUL_LOADING_TIPS.length).toBeGreaterThanOrEqual(6);
    expect(LOADING_TIPS).toHaveLength(
      PRACTICAL_LOADING_TIPS.length + PLAYFUL_LOADING_TIPS.length,
    );
  });

  it("不使用客户端无法验证的进度承诺", () => {
    const copy = LOADING_TIPS.join("\n");
    for (const misleading of ["完成一半", "马上好了", "快好了", "最后质检", "下一秒"] ) {
      expect(copy).not.toContain(misleading);
    }
  });

  it("可以稳定选择池首尾文案", () => {
    expect(pickLoadingTip(() => 0)).toBe(LOADING_TIPS[0]);
    expect(pickLoadingTip(() => 1)).toBe(LOADING_TIPS[LOADING_TIPS.length - 1]);
  });

  it("即使随机数连续相同，也不会重复上一条提示", () => {
    for (const value of [0, 0.5, 1]) {
      const previous = pickLoadingTip(() => value);
      const next = pickLoadingTip(() => value, previous);
      expect(LOADING_TIPS).toContain(next);
      expect(next).not.toBe(previous);
    }
  });
});
