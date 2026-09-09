import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { KnowledgePicker } from "../KnowledgePicker";
import { registerKbProvider, resetKbRegistry } from "@/lib/knowledge-base";
import { useKnowledgeStore } from "@/stores/knowledge-store";

describe("KnowledgePicker", () => {
  beforeEach(() => {
    resetKbRegistry();
    useKnowledgeStore.setState({
      defaultMode: "auto",
      sessionModes: {},
      sourceCount: 0,
      retrievals: {},
    });
  });

  it("未配置知识源时直接进入管理页", () => {
    const onManage = vi.fn();
    render(<KnowledgePicker onManage={onManage} />);
    fireEvent.click(screen.getByRole("button", { name: "添加知识库" }));
    expect(onManage).toHaveBeenCalledOnce();
  });

  it("支持按会话关闭并重新开启自动检索", () => {
    registerKbProvider({ id: "local", label: "本地：notes", isEnabled: () => true, list: () => [] });
    useKnowledgeStore.getState().setSourceCount(1);
    render(<KnowledgePicker sessionId="session-1" onManage={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "知识库 1" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /本次关闭/ }));
    expect(useKnowledgeStore.getState().sessionModes["session-1"]).toBe("off");
    expect(screen.getByRole("button", { name: "知识库已关闭" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "知识库已关闭" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /自动使用/ }));
    expect(useKnowledgeStore.getState().sessionModes["session-1"]).toBe("auto");
  });

  it("显示本轮实际引用结果", () => {
    registerKbProvider({ id: "local", label: "本地：notes", isEnabled: () => true, list: () => [] });
    useKnowledgeStore.setState({
      sourceCount: 1,
      retrievals: {
        "session-1": {
          state: "used",
          resultCount: 2,
          sourceCount: 1,
          titles: ["制度", "流程"],
          items: [{ title: "制度", path: "/notes/policy.md" }, { title: "流程" }],
        },
      },
    });
    render(<KnowledgePicker sessionId="session-1" />);
    expect(screen.getByRole("button", { name: "已引用 2 条" })).toHaveAttribute(
      "title",
      expect.stringContaining("制度、流程"),
    );
  });
});
