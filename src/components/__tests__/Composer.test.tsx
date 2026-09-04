import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Composer } from "../Composer";

const base = { streaming: false, onSend: vi.fn(), onCancel: vi.fn() };

describe("Composer", () => {
  it("空文本且无附件时不可发送", () => {
    const onSend = vi.fn();
    render(<Composer {...base} onSend={onSend} />);
    const input = screen.getByRole("textbox");
    const send = screen.getByRole("button", { name: "发送" });
    expect(send).toBeDisabled();
    fireEvent.keyDown(input, { key: "Enter", shiftKey: false });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("输入后 Enter 发送", () => {
    const onSend = vi.fn();
    render(<Composer {...base} onSend={onSend} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "你好 EchoAgent" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: false });
    expect(onSend).toHaveBeenCalledWith("你好 EchoAgent", []);
  });

  it("apiReady=false 时输入禁用并显示配置提示,点击触发 onOpenSettings", () => {
    const onOpenSettings = vi.fn();
    render(<Composer {...base} apiReady={false} onOpenSettings={onOpenSettings} />);
    expect(screen.getByRole("textbox")).toBeDisabled();
    fireEvent.click(screen.getByText(/请先配置 API Key/));
    expect(onOpenSettings).toHaveBeenCalled();
  });

  it("支持在未配置模型时显示定制引导", () => {
    render(
      <Composer
        {...base}
        apiReady={false}
        setupHint="请先在「设置 → 模型」配置模型"
      />,
    );
    expect(screen.getByText("请先在「设置 → 模型」配置模型")).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toBeDisabled();
  });

  it("showMeta 时渲染权限模式选择器（PermissionPicker）", () => {
    // PermissionPicker 对应 EchoAgent 的 [ui] permission_mode,
    // 默认 ask → 触发器显示"审批模式"。
    render(<Composer {...base} showMeta onPlaceholder={vi.fn()} />);
    expect(screen.getByText(/审批模式/)).toBeInTheDocument();
  });

  it("未传入工作空间数据时不展示无效入口", () => {
    render(<Composer {...base} showMeta />);
    expect(screen.queryByText("选择工作空间")).toBeNull();
  });

  it("后端拒绝发送时保留输入与草稿", async () => {
    const onDraftChange = vi.fn();
    const onSend = vi.fn().mockResolvedValue(false);
    render(
      <Composer
        {...base}
        onSend={onSend}
        draft="不能丢失"
        draftKey="s1"
        onDraftChange={onDraftChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(onSend).toHaveBeenCalled());
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("不能丢失");
    expect(onDraftChange).not.toHaveBeenCalledWith("");
  });

  it("streaming 时显示停止按钮", () => {
    const onCancel = vi.fn();
    render(<Composer {...base} streaming onCancel={onCancel} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "停止生成" }));
    expect(onCancel).toHaveBeenCalled();
  });

  it("取消请求进行中禁用停止按钮，避免重复提交", () => {
    const onCancel = vi.fn();
    render(<Composer {...base} streaming cancelling onCancel={onCancel} />);
    const stop = screen.getByRole("button", { name: "正在停止生成" });
    expect(stop).toBeDisabled();
    fireEvent.click(stop);
    expect(onCancel).not.toHaveBeenCalled();
  });

  // ---------- 按会话持久化草稿 ----------
  it("draft + draftKey 初始回填草稿内容", () => {
    render(
      <Composer
        {...base}
        draft="北京天气怎么样"
        draftKey="s1"
      />,
    );
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
      "北京天气怎么样",
    );
  });

  it("draftKey 变化时回填新草稿(切会话场景)", () => {
    const { rerender } = render(
      <Composer {...base} draft="会话A草稿" draftKey="s1" />,
    );
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
      "会话A草稿",
    );
    rerender(<Composer {...base} draft="会话B草稿" draftKey="s2" />);
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
      "会话B草稿",
    );
  });

  it("用户输入触发 onDraftChange 并带上最新文本", () => {
    const onDraftChange = vi.fn();
    render(
      <Composer {...base} draft="" draftKey="s1" onDraftChange={onDraftChange} />,
    );
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "你好" },
    });
    expect(onDraftChange).toHaveBeenCalledWith("你好");
  });

  it("草稿回填(draftKey 变化)不触发 onDraftChange(避免把恢复内容当用户输入回写)", () => {
    const onDraftChange = vi.fn();
    const { rerender } = render(
      <Composer {...base} draft="" draftKey="s1" onDraftChange={onDraftChange} />,
    );
    onDraftChange.mockClear();
    rerender(
      <Composer {...base} draft="恢复出来的字" draftKey="s2" onDraftChange={onDraftChange} />,
    );
    expect(onDraftChange).not.toHaveBeenCalled();
  });

  it("发送后清空草稿(onDraftChange 收到空串)", () => {
    const onDraftChange = vi.fn();
    render(
      <Composer {...base} draft="待发送" draftKey="s1" onDraftChange={onDraftChange} />,
    );
    onDraftChange.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(onDraftChange).toHaveBeenLastCalledWith("");
  });

  // ---------- 消息队列:流式时入队 ----------
  it("streaming + onEnqueue 时显示入队按钮,点击触发 onEnqueue 并清空输入", () => {
    const onEnqueue = vi.fn();
    const onDraftChange = vi.fn();
    render(
      <Composer
        {...base}
        streaming
        onEnqueue={onEnqueue}
        draft="排队中"
        draftKey="s1"
        onDraftChange={onDraftChange}
      />,
    );
    // 入队按钮可访问名 = "加入待发送队列"。
    const btn = screen.getByRole("button", { name: "加入待发送队列" });
    fireEvent.click(btn);
    expect(onEnqueue).toHaveBeenCalledWith("排队中", []);
    expect(onDraftChange).toHaveBeenLastCalledWith("");
  });

  it("streaming 但文本为空时不渲染入队按钮", () => {
    render(
      <Composer {...base} streaming onEnqueue={vi.fn()} draft="" draftKey="s1" />,
    );
    expect(screen.queryByRole("button", { name: "加入待发送队列" })).toBeNull();
    // 停止按钮仍在。
    expect(screen.getByRole("button", { name: "停止生成" })).toBeInTheDocument();
  });

  it("未传 onEnqueue 时 streaming 不渲染入队按钮(保持原行为)", () => {
    render(<Composer {...base} streaming draft="x" draftKey="s1" />);
    expect(screen.queryByRole("button", { name: "加入待发送队列" })).toBeNull();
  });

  // ---------- 输入历史(arrow-key recall)----------
  it("发送后按 ↑ 召回上一条历史,按 ↓ 回到输入框", () => {
    const onSend = vi.fn();
    render(<Composer {...base} onSend={onSend} />);
    const input = screen.getByRole("textbox") as HTMLTextAreaElement;
    // 发送一条。
    fireEvent.change(input, { target: { value: "第一条" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: false });
    expect(onSend).toHaveBeenCalledWith("第一条", []);
    // 输入框已清空;按 ↑ 召回「第一条」。
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("第一条");
    // 按 ↓ 回到输入框(空)。
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
  });

  it("多次发送后 ↑ 连续上翻历史", () => {
    const onSend = vi.fn();
    render(<Composer {...base} onSend={onSend} />);
    const input = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "a" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: false });
    fireEvent.change(input, { target: { value: "b" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: false });
    // ↑ → b(最新),再 ↑ → a。
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("b");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("a");
  });

  // ---------- 桌面 Slash 命令 ----------
  it("桌面 Slash 命令由客户端处理，不会作为普通消息发送", async () => {
    const onSend = vi.fn();
    const onClientSlashCommand = vi.fn().mockResolvedValue(true);
    const onDraftChange = vi.fn();
    render(
      <Composer
        {...base}
        onSend={onSend}
        onClientSlashCommand={onClientSlashCommand}
        onDraftChange={onDraftChange}
      />,
    );
    const input = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "/settings model" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: false });

    await waitFor(() => expect(onClientSlashCommand).toHaveBeenCalledWith({
      name: "settings",
      args: "model",
    }));
    expect(onSend).not.toHaveBeenCalled();
    expect(input.value).toBe("");
    expect(onDraftChange).toHaveBeenLastCalledWith("");
  });

  it("客户端拒绝 Slash 命令时保留输入", async () => {
    const onSend = vi.fn();
    const onClientSlashCommand = vi.fn().mockResolvedValue(false);
    render(
      <Composer
        {...base}
        draft="/plan maybe"
        draftKey="s1"
        onSend={onSend}
        onClientSlashCommand={onClientSlashCommand}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(onClientSlashCommand).toHaveBeenCalled());
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("/plan maybe");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("运行时 Slash 命令仍按原始文本交给 Agent", () => {
    const onSend = vi.fn();
    const onClientSlashCommand = vi.fn();
    render(
      <Composer
        {...base}
        draft="/acme:review staged"
        draftKey="s1"
        onSend={onSend}
        onClientSlashCommand={onClientSlashCommand}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(onClientSlashCommand).not.toHaveBeenCalled();
    expect(onSend).toHaveBeenCalledWith("/acme:review staged", []);
  });

  it("编辑重发时同时恢复正文和附件", () => {
    const onSend = vi.fn();
    render(
      <Composer
        {...base}
        onSend={onSend}
        externalText="请继续优化"
        externalAttachments={["/tmp/方案.docx"]}
        externalTextNonce={1}
      />,
    );
    expect(screen.getByText("方案.docx")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(onSend).toHaveBeenCalledWith("请继续优化", ["/tmp/方案.docx"]);
  });
});
