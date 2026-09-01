import { describe, it, expect, beforeEach } from "vitest";
import { act, render, screen, fireEvent } from "@testing-library/react";
import { UsageQuotaPanel } from "../UsageQuotaPanel";
import { recordUsage, clearUsage, saveQuotaConfig, type UsageRecord } from "@/lib/usage-quota";

describe("UsageQuotaPanel", () => {
  beforeEach(() => {
    clearUsage();
    window.localStorage.removeItem("echoagent.quota");
  });

  it("空数据显示 0 token + 0 调用", () => {
    render(<UsageQuotaPanel />);
    // 空数据时总 Token 显示 0(作为 stat-value)。
    const tokenStat = screen.getByText("总 Token");
    expect(tokenStat.previousElementSibling?.textContent).toBe("0");
    expect(screen.getByText("模型调用")).toBeInTheDocument();
  });

  it("有用量记录 → 显示汇总", () => {
    recordUsage([], { modelId: "gpt-4", promptTokens: 500, completionTokens: 200 });
    render(<UsageQuotaPanel />);
    // totalTokens = 700
    expect(screen.getAllByText("700").length).toBeGreaterThan(0);
    const calls = screen.getByText("模型调用");
    expect(calls.previousElementSibling?.textContent).toBe("1");
  });

  it("切换本月/今日周期", () => {
    render(<UsageQuotaPanel />);
    expect(screen.getByText("今日")).toBeInTheDocument();
    fireEvent.click(screen.getByText("本月"));
    // 重新渲染后仍正常。
    expect(screen.getByText("总 Token")).toBeInTheDocument();
  });

  it("配置配额 → 显示进度条", () => {
    recordUsage([], { modelId: "gpt-4", promptTokens: 800, completionTokens: 200 });
    saveQuotaConfig({ period: "daily", tokenLimit: 1000 });
    render(<UsageQuotaPanel />);
    // 1000 token used = 1000, limit 1000 → pct 100
    expect(screen.getByText(/1,000 \/ 1,000/)).toBeInTheDocument();
  });

  it("按模型分组显示", () => {
    recordUsage([], { modelId: "gpt-4", promptTokens: 100, completionTokens: 50 });
    recordUsage([{
      date: new Date().toISOString().slice(0, 10),
      modelId: "gpt-4",
      promptTokens: 100,
      completionTokens: 50,
      ts: Date.now(),
    } as UsageRecord], { modelId: "claude", promptTokens: 50, completionTokens: 30 });
    render(<UsageQuotaPanel />);
    expect(screen.getAllByText("gpt-4").length).toBeGreaterThan(0);
    expect(screen.getAllByText("claude").length).toBeGreaterThan(0);
  });

  it("面板打开时用量变化会实时刷新", () => {
    render(<UsageQuotaPanel />);
    act(() => {
      recordUsage([], { modelId: "gpt-4", promptTokens: 90, completionTokens: 10 });
    });
    expect(screen.getAllByText("100").length).toBeGreaterThan(0);
  });

  it("可配置本地模型费率", () => {
    recordUsage([], { modelId: "gpt-4", promptTokens: 1000, completionTokens: 500 });
    render(<UsageQuotaPanel />);
    fireEvent.change(screen.getByLabelText("gpt-4 输入费率"), { target: { value: "30" } });
    fireEvent.change(screen.getByLabelText("gpt-4 输出费率"), { target: { value: "60" } });
    fireEvent.click(screen.getByText("保存费率"));
    expect(screen.getByText("本地估算费率已保存，历史记录已按新费率重新计算。")).toBeInTheDocument();
    expect(screen.getAllByText("$0.0600").length).toBeGreaterThan(0);
  });
});
