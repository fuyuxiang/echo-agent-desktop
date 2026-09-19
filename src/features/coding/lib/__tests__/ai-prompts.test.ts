import { describe, expect, it } from "vitest";

import {
  buildRefactorPrompt,
  buildReviewPrompt,
  buildTestsPrompt,
  truncateForReview,
  type DocumentSnippet,
} from "@/features/coding/lib/ai-prompts";

const doc = (path: string, content: string, hash = "h"): DocumentSnippet => ({
  path,
  hash,
  content,
});

describe("buildReviewPrompt", () => {
  it("N 个文件拼接 N 个 ### 块", () => {
    const result = buildReviewPrompt([
      doc("/a.ts", "alpha"),
      doc("/b.ts", "bravo"),
    ]);
    expect(result).toContain("### /a.ts");
    expect(result).toContain("### /b.ts");
    expect(result).toContain("alpha");
    expect(result).toContain("bravo");
    expect(result).toContain("2 个文件");
  });

  it("文件内容 > 8000 字截断 + 省略标记", () => {
    const big = "x".repeat(9000);
    const result = buildReviewPrompt([doc("/big.ts", big)]);
    expect(result).toContain("后续省略");
    // Original first 8000 chars still present
    expect(result).toContain("x".repeat(100));
    expect(result).not.toContain("x".repeat(8001));
  });

  it("空 docs 返回字符串含「0 个文件」", () => {
    const result = buildReviewPrompt([]);
    expect(result).toContain("0 个文件");
  });

  it("每个文件块包含 markdown 代码围栏", () => {
    const result = buildReviewPrompt([doc("/x.ts", "x")]);
    expect(result).toContain("```\nx\n```");
  });
});

describe("truncateForReview", () => {
  it("短内容原样返回", () => {
    expect(truncateForReview("hello")).toBe("hello");
  });
  it("超长内容标记省略", () => {
    const out = truncateForReview("a".repeat(9000));
    expect(out).toContain("后续省略");
    expect(out.length).toBeLessThan(9000);
  });
});

describe("buildRefactorPrompt", () => {
  it("userNote 非空时拼接「用户关注点」段", () => {
    const result = buildRefactorPrompt(["/a.ts"], "拆分大函数");
    expect(result).toContain("用户关注点");
    expect(result).toContain("拆分大函数");
    expect(result).toContain("/a.ts");
  });

  it("userNote 为空时不渲染关注点段", () => {
    const result = buildRefactorPrompt(["/a.ts"], "");
    expect(result).not.toContain("用户关注点");
    expect(result).toContain("重构方案");
  });

  it("userNote 全空白也视作空", () => {
    const result = buildRefactorPrompt(["/a.ts"], "   \n  ");
    expect(result).not.toContain("用户关注点");
  });
});

describe("buildTestsPrompt", () => {
  it("framework=null 时输出「自动推断」", () => {
    const result = buildTestsPrompt(["/a.ts"], null, "");
    expect(result).toContain("自动推断");
  });

  it("framework='vitest' 注入到 prompt", () => {
    const result = buildTestsPrompt(["/a.ts"], "vitest", "");
    expect(result).toContain("vitest 测试");
  });

  it("userNote 非空时拼接「覆盖要求」段", () => {
    const result = buildTestsPrompt(["/a.ts"], "vitest", "边界条件");
    expect(result).toContain("覆盖要求");
    expect(result).toContain("边界条件");
  });
});
