import { describe, expect, it } from "vitest";
import {
  isConfiguredModelId,
  resolveConfiguredModelId,
  resolveSessionModelId,
} from "../model-selection";

describe("resolveConfiguredModelId", () => {
  const configured = [
    { id: "glm-5", label: "GLM 5" },
    { id: "runtime-default", label: "Runtime Default" },
  ];

  it("没有已配置模型时不暴露 Runtime 默认值", () => {
    expect(resolveConfiguredModelId([], undefined, "runtime-default")).toBeUndefined();
  });

  it("优先保留仍在配置列表中的当前模型", () => {
    expect(resolveConfiguredModelId(configured, "glm-5", "runtime-default")).toBe("glm-5");
  });

  it("Runtime 默认值未配置时选择第一个用户模型", () => {
    expect(resolveConfiguredModelId(configured.slice(0, 1), undefined, "runtime-default")).toBe("glm-5");
  });

  it("会话模型未配置时不回退到其他模型", () => {
    expect(resolveSessionModelId(configured.slice(0, 1), "runtime-default")).toBeUndefined();
    expect(resolveSessionModelId(configured.slice(0, 1), undefined)).toBeUndefined();
  });

  it("只把配置列表中的 id 视为可用模型", () => {
    expect(isConfiguredModelId(configured, "glm-5")).toBe(true);
    expect(isConfiguredModelId(configured, "missing")).toBe(false);
  });
});
