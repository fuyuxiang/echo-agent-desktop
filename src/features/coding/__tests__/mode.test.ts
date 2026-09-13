import { describe, expect, it } from "vitest";

import {
  buildCodingModePrompt,
  codingModeOption,
} from "../lib/mode";

describe("coding work modes", () => {
  it("gives each mode distinct user-facing semantics", () => {
    expect(codingModeOption("ask").description).toContain("只读");
    expect(codingModeOption("plan").description).toContain("批准后");
    expect(codingModeOption("agent").description).toContain("验证");
  });

  it("builds an Ask contract that stays read-only on follow-ups", () => {
    const prompt = buildCodingModePrompt("ask", "再解释一下", [], true);
    expect(prompt).toContain("Ask / 只读追问");
    expect(prompt).toContain("禁止修改、创建或删除文件");
    expect(prompt).toContain("不要提交实施计划");
    expect(prompt).toContain("用户追问：\n再解释一下");
  });

  it("deduplicates and exposes pinned context without changing visible text", () => {
    const prompt = buildCodingModePrompt(
      "plan",
      "迁移登录",
      [" src/auth.ts ", "src/auth.ts", "src/session.ts"],
    );
    expect(prompt.match(/src\/auth\.ts/g)).toHaveLength(1);
    expect(prompt).toContain("src/session.ts");
    expect(prompt).toContain("用户请求：\n迁移登录");
  });
});
