import { describe, expect, it } from "vitest";

import {
  buildDocumentationProtocol,
  createDocumentationRequest,
  createDocumentationWorkflow,
  isDocumentationRequest,
  type EditorCodeContext,
} from "../lib/documentation";

const editorContext = (overrides: Partial<EditorCodeContext> = {}): EditorCodeContext => ({
  path: "src/payment/refund.ts",
  language: "typescript",
  cursorLine: 18,
  cursorColumn: 7,
  startLine: 18,
  startColumn: 1,
  endLine: 24,
  endColumn: 2,
  selectedText: "export async function requestRefund() {}",
  selectionTruncated: false,
  symbol: {
    name: "requestRefund",
    kind: "function",
    startLine: 18,
    endLine: 44,
  },
  ...overrides,
});

describe("documentation intent", () => {
  it("recognizes conversational and slash-command requests", () => {
    expect(isDocumentationRequest("/doc 说明退款规则")).toBe(true);
    expect(isDocumentationRequest("/explain current module")).toBe(true);
    expect(isDocumentationRequest("为当前函数生成 JSDoc")).toBe(true);
    expect(isDocumentationRequest("给这段代码增加注释")).toBe(true);
    expect(isDocumentationRequest("完善当前模块注释")).toBe(true);
    expect(isDocumentationRequest("清除当前文件中的过期注释")).toBe(true);
    expect(isDocumentationRequest("Add JSDoc to this function")).toBe(true);
    expect(isDocumentationRequest("梳理跨模块调用链和业务规则")).toBe(true);
    expect(isDocumentationRequest("修复登录接口的竞态条件")).toBe(false);
    expect(isDocumentationRequest("实现多粒度代码注释生成能力")).toBe(false);
  });

  it("uses selection/symbol scope by default and lets explicit system scope win", () => {
    expect(createDocumentationRequest("生成代码注释", editorContext()).scope).toBe("symbol");
    const system = createDocumentationRequest(
      "为跨模块退款全链路生成系统级文档和注释",
      editorContext(),
    );
    expect(system.scope).toBe("system");
    expect(system.outputs).toEqual([
      "architecture_documentation",
      "module_documentation",
      "source_comments",
    ]);
    expect(createDocumentationRequest("生成系统级架构文档", editorContext()).outputs)
      .toEqual(["architecture_documentation", "module_documentation"]);
    expect(createDocumentationRequest("更新跨模块调用关系的代码注释").outputs)
      .toEqual(["source_comments"]);
    expect(createDocumentationRequest("生成当前模块文档", editorContext({
      selectedText: "",
      symbol: undefined,
    })).outputs).toEqual(["module_documentation"]);
    expect(createDocumentationRequest("清除工程里的过期注释").outputs)
      .toEqual(["source_comments"]);
  });

  it("keeps code explanations read-only", () => {
    const request = createDocumentationRequest(
      "解释当前函数的边界条件，只做分析，不修改文件",
      editorContext(),
    );
    expect(request.operation).toBe("explain");
    expect(request.outputs).toEqual(["chat_explanation"]);
    expect(createDocumentationRequest("Explain the current module").operation).toBe("explain");
    expect(createDocumentationRequest("添加函数注释，不修改业务逻辑").operation).toBe("write");
    expect(createDocumentationRequest("修复登录竞态并补充代码注释").allowExecutableChanges)
      .toBe(true);
    expect(createDocumentationRequest("完善当前函数注释").allowExecutableChanges)
      .toBe(false);
  });

  it("builds an evidence-scoped protocol with semantic and no-logic-change gates", () => {
    const protocol = buildDocumentationProtocol(createDocumentationWorkflow(
      "为当前函数生成注释",
      editorContext(),
      { indexReady: false, symbol: null, impact: null },
    ));
    expect(protocol).toContain("src/payment/refund.ts");
    expect(protocol).toContain("requestRefund");
    expect(protocol).toContain("选区（仅作为代码证据");
    expect(protocol).toContain("BR-业务规则");
    expect(protocol).toContain("禁止改变可执行逻辑");
    expect(protocol).toContain("不得假设跨文件关系");
  });

  it("keeps system-wide source comments separate from architecture artifacts", () => {
    const sourceComments = buildDocumentationProtocol(createDocumentationWorkflow(
      "清除工程里的过期注释",
    ));
    expect(sourceComments).toContain("不额外创建用户未要求的架构文档");
    expect(sourceComments).not.toContain("生成或更新 `docs/`");

    const architecture = buildDocumentationProtocol(createDocumentationWorkflow(
      "生成系统级架构文档",
    ));
    expect(architecture).toContain("生成或更新 `docs/`");
  });

  it("does not apply the comment-only gate to a mixed implementation request", () => {
    const protocol = buildDocumentationProtocol(createDocumentationWorkflow(
      "为登录服务增加缓存并补充代码注释",
    ));
    expect(protocol).toContain("实现与文档的混合任务");
    expect(protocol).toContain("可以在用户需求范围内修改可执行逻辑");
  });
});
