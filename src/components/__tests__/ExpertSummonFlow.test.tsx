import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExpertsTab } from "../experts-panel/experts/ExpertsTab";
import { usePendingExpertStore } from "@/stores/pending-expert-store";
import type { ExpertItem } from "@/lib/types";

const api = vi.hoisted(() => ({
  expertsDefaultRoot: vi.fn(), expertsLoad: vi.fn(), expertsReadAgentPrompt: vi.fn(), expertsLinkAgents: vi.fn(),
}));
vi.mock("@/lib/agent-client", () => api);
vi.mock("../experts-panel/shared/ThumbImg", () => ({ ThumbImg: () => null }));

const expert: ExpertItem = {
  id: "review", cat: "dev", name: "评审专家", title: "代码评审", desc: "检查代码", tags: [],
  type: "agent", plugin: "review", agentName: "lead",
};

describe("市场专家准备与失败恢复", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    usePendingExpertStore.getState().clear();
    api.expertsDefaultRoot.mockResolvedValue("/tmp/experts");
    api.expertsLoad.mockResolvedValue({ root: "/tmp/experts", categories: [], experts: [expert], featuredScenes: [] });
    api.expertsReadAgentPrompt.mockResolvedValue("---\nname: reviewer\n---\n检查正确性和风险。");
    api.expertsLinkAgents.mockResolvedValue(2);
  });

  async function openExpert(onGoHome = vi.fn()) {
    render(<ExpertsTab pills={null} onGoHome={onGoHome} />);
    fireEvent.click(await screen.findByRole("button", { name: "召唤专家 代码评审" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "召唤 代码评审" })));
    return onGoHome;
  }

  it("提示词读取失败保留专家详情并允许重试，不创建空提示词专家", async () => {
    api.expertsReadAgentPrompt.mockRejectedValueOnce(new Error("文件已移动"));
    const onGoHome = await openExpert();
    expect(await screen.findByRole("alert")).toHaveTextContent("文件已移动");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(onGoHome).not.toHaveBeenCalled();
    expect(usePendingExpertStore.getState().expert).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "召唤 代码评审" }));
    await waitFor(() => expect(onGoHome).toHaveBeenCalledOnce());
    expect(usePendingExpertStore.getState().expert?.prompt).toBe("检查正确性和风险。");
  });

  it("团队成员链接失败不导航或声明专家团已准备成功", async () => {
    api.expertsLoad.mockResolvedValue({ root: "/tmp/experts", categories: [], experts: [{ ...expert, type: "team" }], featuredScenes: [] });
    api.expertsLinkAgents.mockRejectedValueOnce(new Error("agents 目录不可写"));
    const onGoHome = vi.fn();
    render(<ExpertsTab pills={null} onGoHome={onGoHome} />);
    fireEvent.click(await screen.findByRole("tab", { name: "专家团" }));
    fireEvent.click(await screen.findByRole("button", { name: "召唤专家 代码评审" }));
    fireEvent.click(screen.getByRole("button", { name: "召唤 代码评审" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("agents 目录不可写");
    expect(onGoHome).not.toHaveBeenCalled();
    expect(usePendingExpertStore.getState().expert).toBeNull();
  });

  it("关闭准备中的详情后迟到提示词不会重新召唤专家", async () => {
    let resolve!: (value: string) => void;
    api.expertsReadAgentPrompt.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const onGoHome = await openExpert();
    expect(screen.getByRole("button", { name: "正在准备专家…" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    await act(async () => resolve("专家提示词"));
    expect(onGoHome).not.toHaveBeenCalled();
    expect(usePendingExpertStore.getState().expert).toBeNull();
  });
});
