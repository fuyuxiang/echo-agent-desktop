import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { Markdown } from "../Markdown";

/**
 * Markdown.findQuery 集成契约
 * --------------------------
 * 背景:会话内查找依赖 Markdown 在 findQuery 变化时用新关键词重渲染并产出
 * `<mark class="find-hit">`,ChatView 用 querySelectorAll(".find-hit") 推导出现处。
 * 之前 memo 比较器漏写 findQuery,导致 query 变化后 React 跳过重渲染,
 * 整个查找链路返回 0 命中。下列测试锁定该契约,任何漏写 prop 的回归会立即失败。
 */
describe("Markdown.findQuery 集成契约", () => {
  // 「鸟」出现 3 次:火烈鸟 / 鸟 (独立) / 鸟类。「湖」回稳后用于第 3 个用例。
  const SAMPLE = `森林里住着一只火烈鸟。这只鸟属于鸟类,每天在湖边单腿站立,优雅地保暖。`;

  it("首次渲染 findQuery=\"\" 时不应注入任何 <mark.find-hit>", () => {
    const { container } = render(<Markdown findQuery="">{SAMPLE}</Markdown>);
    expect(container.querySelectorAll("mark.find-hit").length).toBe(0);
  });

  it("findQuery 从 \"\" 变为 \"鸟\" 时必须重新渲染并产出 <mark.find-hit>", () => {
    const { container, rerender } = render(<Markdown findQuery="">{SAMPLE}</Markdown>);
    expect(container.querySelectorAll("mark.find-hit").length).toBe(0);

    rerender(<Markdown findQuery="鸟">{SAMPLE}</Markdown>);

    const marks = container.querySelectorAll("mark.find-hit");
    expect(marks.length).toBe(3); // 火烈鸟 + 鸟 + 鸟类
    marks.forEach((mark) => {
      expect(mark.textContent).toBe("鸟");
    });
  });

  it("findQuery 切换到不同关键词时,旧高亮必须消失,新关键词被高亮", () => {
    const { container, rerender } = render(<Markdown findQuery="鸟">{SAMPLE}</Markdown>);
    expect(container.querySelectorAll("mark.find-hit").length).toBeGreaterThanOrEqual(2);

    rerender(<Markdown findQuery="湖">{SAMPLE}</Markdown>);

    const marks = container.querySelectorAll("mark.find-hit");
    expect(marks.length).toBeGreaterThanOrEqual(1);
    marks.forEach((mark) => {
      expect(mark.textContent).toBe("湖");
    });
    // 不能再残留「鸟」高亮
    expect(container.textContent).toContain("鸟");
    const strayBirdMarks = Array.from(marks).filter((m) => m.textContent === "鸟");
    expect(strayBirdMarks.length).toBe(0);
  });

  it("findQuery 清空回 \"\" 时高亮必须完全消失", () => {
    const { container, rerender } = render(<Markdown findQuery="鸟">{SAMPLE}</Markdown>);
    expect(container.querySelectorAll("mark.find-hit").length).toBeGreaterThan(0);

    rerender(<Markdown findQuery="">{SAMPLE}</Markdown>);

    expect(container.querySelectorAll("mark.find-hit").length).toBe(0);
  });
});