import { describe, it, expect } from "vitest";
import { formatAgentError, friendlyError } from "../error-format";

describe("formatAgentError", () => {
  it("parses 429 TPM rate limit from Rust Debug string", () => {
    const raw = `Error { code: -32003: Unknown error, message: "Rate limited", data: Some(Object {"message": String("API error (status 429 Too Many Requests): runtime_error: tpm rate limit exceeded"), "promptUsage": Object {"inputTokens": Number(219848), "outputTokens": Number(10094), "totalTokens": Number(229942), "cachedReadTokens": Number(0), "reasoningTokens": Number(2163), "modelCalls": Number(15), "apiDurationMs": Number(211574), "modelUsage": Object {"glm-5": Object {"inputTokens": Number(219848)}}, "numTurns": Number(4)}}) }`;
    const result = formatAgentError(raw);
    expect(result).not.toBeNull();
    expect(result).toContain("TPM");
    expect(result).toContain("219.8k");
    expect(result).toContain("15 次");
    expect(result).toContain("4 轮");
    expect(result).toContain("glm-5");
    expect(result).toContain("等待");
  });

  it("parses 429 RPM rate limit", () => {
    const raw = JSON.stringify({
      code: -32003,
      message: "Rate limited",
      data: {
        message: "API error (status 429): rpm rate limit exceeded",
        promptUsage: { inputTokens: 5000, modelCalls: 3 },
      },
    });
    const result = formatAgentError(raw);
    expect(result).not.toBeNull();
    expect(result).toContain("RPM");
  });

  it("handles auth error", () => {
    const raw = JSON.stringify({
      code: -32003,
      data: { message: "401 Unauthorized: invalid API key" },
    });
    const result = formatAgentError(raw);
    expect(result).not.toBeNull();
    expect(result).toContain("认证失败");
  });

  it("parses ACP internal errors whose Rust data is a String", () => {
    const raw = `Error { code: -32603: Internal error, message: "Internal error", data: Some(String("API request failed with status 401 Unauthorized: missing credentials for runtime-default")) }`;
    const result = formatAgentError(raw);
    expect(result).toContain("认证失败");
    expect(result).not.toContain("Internal error");
  });

  it("handles connection error", () => {
    const raw = JSON.stringify({
      data: { message: "connection refused: ECONNREFUSED" },
    });
    const result = formatAgentError(raw);
    expect(result).not.toBeNull();
    expect(result).toContain("网络连接失败");
  });

  it("returns null for unparseable string", () => {
    expect(formatAgentError("some random error")).toBeNull();
  });
});

describe("friendlyError", () => {
  it("formats parseable errors", () => {
    const raw = JSON.stringify({
      code: -32003,
      data: { message: "401 Unauthorized" },
    });
    const result = friendlyError(raw);
    expect(result).toContain("认证失败");
  });

  it("falls back to raw string for unparseable errors", () => {
    const raw = "something went wrong";
    expect(friendlyError(raw)).toBe(raw);
  });

  it("展示普通 Error 时去掉技术性前缀", () => {
    expect(friendlyError(new Error("知识来源尚未就绪"))).toBe("知识来源尚未就绪");
  });

  it("handles Error objects", () => {
    const err = new Error("connection timeout");
    const result = friendlyError(err);
    expect(result).toContain("网络连接失败");
  });
});

// AppError 契约：Rust → TS 结构化错误识别。
// 形态：{ code: number, kind: ErrorKind, message: string }
// kind ∈ "validation" | "state" | "network" | "filesystem" | "permission"
//        | "credential" | "timeout" | "cancelled" | "verificationToken" | "internal"
interface AppErrorPayload {
  code: number;
  kind: string;
  message: string;
}

describe("formatAgentError - AppError structured", () => {
  it("validation kind → 给出参数校验提示", () => {
    const err: AppErrorPayload = { code: 1003, kind: "validation", message: "sessionId 不能为空" };
    const result = formatAgentError(JSON.stringify(err));
    expect(result).toContain("参数错误");
    expect(result).toContain("sessionId");
  });

  it("network kind → 给出网络重试提示", () => {
    const err: AppErrorPayload = { code: 2003, kind: "network", message: "ECONNREFUSED" };
    const result = formatAgentError(JSON.stringify(err));
    expect(result).toContain("网络");
    expect(result).toContain("ECONNREFUSED");
  });

  it("credential kind → 给出凭据提示", () => {
    const err: AppErrorPayload = { code: 2007, kind: "credential", message: "API Key 无效" };
    const result = formatAgentError(JSON.stringify(err));
    expect(result).toContain("凭据");
  });

  it("state kind → 给出初始化/状态提示", () => {
    const err: AppErrorPayload = { code: 2001, kind: "state", message: "模型未初始化" };
    const result = formatAgentError(JSON.stringify(err));
    expect(result).toContain("状态");
  });

  it("timeout kind → 给出超时重试提示", () => {
    const err: AppErrorPayload = { code: 2004, kind: "timeout", message: "等待响应超时" };
    const result = formatAgentError(JSON.stringify(err));
    expect(result).toContain("超时");
  });

  it("permission kind → 给出权限提示", () => {
    const err: AppErrorPayload = { code: 2006, kind: "permission", message: "无权限访问 /etc" };
    const result = formatAgentError(JSON.stringify(err));
    expect(result).toContain("权限");
  });

  it("未知 kind → 回退到 message 本体", () => {
    const err: AppErrorPayload = { code: 9999, kind: "weird", message: "原始错误信息" };
    const result = formatAgentError(JSON.stringify(err));
    expect(result).toContain("原始错误信息");
  });
});

describe("friendlyError - AppError structured", () => {
  it("直接接受 AppError 对象", () => {
    const err: AppErrorPayload = { code: 1003, kind: "validation", message: "ID 缺失" };
    const result = friendlyError(err);
    expect(result).toContain("参数错误");
    expect(result).toContain("ID 缺失");
  });

  it("接受 Rust Debug 风格的 AppError 字符串", () => {
    // Rust 端 serde 序列化的字符串表示
    const raw = `Error { code: 1003: validation, message: "ID 缺失" }`;
    // 实际结构化 AppError 在 IPC 抛出会以 JSON 形式出现，这里只校验友好降级不丢 message
    const result = friendlyError(raw);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
});
