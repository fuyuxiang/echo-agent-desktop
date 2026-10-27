import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ContextUsagePill } from "../ContextUsagePill";
import { agentSessionInfo } from "@/lib/agent-client";
import { estimateSendCost } from "@/lib/token-estimate";
vi.mock("@/lib/agent-client", () => ({ agentSessionInfo: vi.fn(), agentSessionUsage: vi.fn(async () => null) }));
const snapshot = (usagePct: number) => ({ context: { used: usagePct * 1000, total: 100000, usagePct, messageTokens: 100, toolDefinitionsTokens: 100, systemPromptTokens: 100 } });

describe("context disclosure", () => {
  beforeEach(() => vi.mocked(agentSessionInfo).mockReset());
  it("无快照时仍可按需检查输入估算，明确非计费结果", () => {
    render(<ContextUsagePill estimate={estimateSendCost("检查任务交付")} />);
    const trigger = screen.getByRole("button", {name:"上下文与用量详情"});
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog",{name:"上下文详情"})).toHaveTextContent("仅为本地估算，非计费结果");
    fireEvent.keyDown(document,{key:"Escape"});
    expect(screen.queryByRole("dialog")).toBeNull(); expect(trigger).toHaveFocus();
  });
  it("正常容量也显示进度环，达到阈值时额外显示占用数字", async () => {
    vi.mocked(agentSessionInfo).mockResolvedValue(snapshot(30) as never);
    const {rerender} = render(<ContextUsagePill sessionId="a" />);
    const trigger = await screen.findByRole("button",{name:"上下文已使用 30%"});
    expect(trigger.querySelector(".context-usage__ring-progress")).toBeInTheDocument();
    expect(screen.queryByText("30%")).toBeNull();
    vi.mocked(agentSessionInfo).mockResolvedValue(snapshot(85) as never);
    rerender(<ContextUsagePill sessionId="b" />);
    await screen.findByRole("button",{name:"上下文已使用 85%"});
    expect(screen.getByText("85%")).toBeVisible();
  });
  it("迟到的旧会话快照不会覆盖新会话", async () => {
    let resolveA!: (value: never) => void;
    vi.mocked(agentSessionInfo).mockImplementationOnce(() => new Promise(resolve => { resolveA = resolve; }));
    const {rerender} = render(<ContextUsagePill sessionId="a" />);
    vi.mocked(agentSessionInfo).mockResolvedValue(snapshot(70) as never);
    rerender(<ContextUsagePill sessionId="b" />);
    await screen.findByRole("button",{name:"上下文已使用 70%"});
    await act(async () => resolveA(snapshot(95) as never));
    await waitFor(() => expect(screen.getByRole("button",{name:"上下文已使用 70%"})).toBeVisible());
    expect(screen.queryByText("95%")).toBeNull();
  });
});
