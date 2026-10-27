import { describe, it, expect, vi } from "vitest";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Composer } from "../Composer";
import * as agentClient from "@/lib/agent-client";

const base = { streaming: false, onSend: vi.fn(), onCancel: vi.fn() };

describe("Composer", () => {
  it.each(["", "补充要求"])("通过菜单暂停时保留草稿和附件，并阻止重复操作：%s", async draft => {
    let finish!: (accepted: boolean) => void;
    const onPause = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; }));
    const onCancel = vi.fn();
    const onEnqueue = vi.fn();
    render(<Composer {...base} streaming onPause={onPause} onCancel={onCancel} onEnqueue={onEnqueue}
      externalText={draft} externalAttachments={["/tmp/方案.docx"]} externalTextNonce={1} />);
    fireEvent.click(screen.getByRole("button", {name:"发送选项"}));
    fireEvent.click(screen.getByRole("menuitem", {name:"暂停任务"}));
    expect(onPause).toHaveBeenCalledOnce();
    expect(screen.getByRole("textbox")).toHaveValue(draft);
    expect(screen.getByText("方案.docx")).toBeInTheDocument();
    expect(screen.getByRole("button", {name:"停止生成"})).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("textbox"), {key:"Enter"});
    expect(onEnqueue).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", {name:"发送选项"}));
    expect(screen.getByRole("menuitem", {name:"正在暂停…"})).toBeDisabled();
    finish(false);
    await waitFor(() => expect(screen.getByRole("menuitem", {name:"暂停任务"})).toBeEnabled());
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("空草稿和目录不可用时仍可从菜单暂停任务", async () => {
    const onPause = vi.fn(async () => true);
    render(<Composer {...base} streaming sendDisabled onPause={onPause} />);
    fireEvent.click(screen.getByRole("button", {name:"发送选项"}));
    fireEvent.click(screen.getByRole("menuitem", {name:"暂停任务"}));
    await waitFor(() => expect(onPause).toHaveBeenCalledOnce());
    expect(screen.getByRole("textbox")).toHaveValue("");
  });

  it("切换任务后，旧任务的暂停请求不会阻止新任务发送", async () => {
    let finish!: () => void;
    const onPause = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const onSend = vi.fn(async () => true);
    const view = render(<Composer {...base} streaming draftKey="old" draft="旧草稿" onPause={onPause} />);
    fireEvent.click(screen.getByRole("button", { name: "发送选项" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "暂停任务" }));
    view.rerender(<Composer {...base} draftKey="new" draft="新任务" onPause={onPause} onSend={onSend} />);
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    await waitFor(() => expect(onSend).toHaveBeenCalledExactlyOnceWith("新任务", []));
    await act(async () => finish());
  });

  it("旧任务暂停完成时不会解除新任务正在等待的暂停操作", async () => {
    const completions: (() => void)[] = [];
    const onPause = vi.fn(() => new Promise<void>(resolve => { completions.push(resolve); }));
    const view = render(<Composer {...base} streaming draftKey="old" onPause={onPause} />);
    const pause = () => {
      fireEvent.click(screen.getByRole("button", { name: "发送选项" }));
      fireEvent.click(screen.getByRole("menuitem", { name: "暂停任务" }));
    };
    pause();
    view.rerender(<Composer {...base} streaming draftKey="new" draft="新任务草稿" onPause={onPause} />);
    pause();
    expect(onPause).toHaveBeenCalledTimes(2);
    await act(async () => completions[0]());
    expect(screen.getByRole("button", { name: "停止生成" })).toBeDisabled();
    expect(screen.getByRole("textbox")).toHaveValue("新任务草稿");
    await act(async () => completions[1]());
    expect(screen.getByRole("button", { name: "停止生成" })).toBeEnabled();
  });

  it("选择文件夹期间不能发送；取消后保留草稿并恢复提交", async () => {
    let resolve!: (cwd: string | null) => void;
    const picker = vi.spyOn(agentClient, "filesystemPickDirectory").mockImplementationOnce(() => new Promise(accept => { resolve = accept; }));
    const send = vi.fn(async () => true);
    render(<Composer {...base} onSend={send} showMeta cwd="/original" workspaces={[]} onSelectWorkspace={vi.fn()} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, {target:{value:"保留需求"}});
    fireEvent.click(screen.getByRole("button", {name:/工作目录：/}));
    fireEvent.click(screen.getByRole("menuitem", {name:"选择文件夹…"}));
    fireEvent.keyDown(input, {key:"Enter"});
    expect(send).not.toHaveBeenCalled();
    expect(screen.getByRole("button", {name:"发送"})).toBeDisabled();
    resolve(null);
    await waitFor(() => expect(screen.getByRole("button", {name:"发送"})).toBeEnabled());
    expect(input).toHaveValue("保留需求");
    fireEvent.keyDown(input, {key:"Enter"});
    await waitFor(() => expect(send).toHaveBeenCalledExactlyOnceWith("保留需求", []));
    picker.mockRestore();
  });

  it("目录不可用时仍可编辑草稿，所有发送入口保持禁用", () => {
    const send = vi.fn();
    render(<Composer {...base} onSend={send} sendDisabled />);
    const input = screen.getByRole("textbox");
    expect(input).toBeEnabled();
    fireEvent.change(input, {target:{value:"恢复后继续"}});
    fireEvent.keyDown(input, {key:"Enter"});
    expect(send).not.toHaveBeenCalled();
    expect(input).toHaveValue("恢复后继续");
    expect(screen.getByRole("button", {name:"发送"})).toBeDisabled();
  });

  it("running Enter queues; interruption is explicit and a rejected replacement keeps the draft", async () => {
    const onEnqueue = vi.fn();
    const onSendNow = vi.fn().mockResolvedValue(false);
    render(<Composer {...base} streaming onEnqueue={onEnqueue} onSendNow={onSendNow} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, {target: {value: "下一步核验"}});
    fireEvent.keyDown(input, {key:"Enter", keyCode:229});
    expect(onEnqueue).not.toHaveBeenCalled();
    fireEvent.keyDown(input, {key:"Enter", shiftKey:true});
    expect(onEnqueue).not.toHaveBeenCalled();
    fireEvent.keyDown(input, {key:"Enter"});
    expect(onEnqueue).toHaveBeenCalledExactlyOnceWith("下一步核验", []);
    expect(onSendNow).not.toHaveBeenCalled();
    fireEvent.change(input, {target: {value: "改为生成报告"}});
    fireEvent.click(screen.getByRole("button", {name:"发送选项"}));
    fireEvent.click(screen.getByRole("menuitem", {name:"中断当前轮次并发送"}));
    await waitFor(()=>expect(onSendNow).toHaveBeenCalledExactlyOnceWith("改为生成报告", []));
    expect(input).toHaveValue("改为生成报告");
  });

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
    fireEvent.click(screen.getByText(/请先在「设置 → 模型」检查可用模型和连接/));
    expect(onOpenSettings).toHaveBeenCalled();
  });

  it("会话加载只显示一处状态提示，不引导用户配置模型", () => {
    render(<Composer {...base} apiReady={false} setupHint="正在加载会话信息…" modelLoading models={[{ id: "model-a" }]} onModelChange={vi.fn()} />);
    expect(screen.getAllByText("正在加载会话信息…")).toHaveLength(1);
    expect(screen.getByRole("textbox")).toHaveAttribute("placeholder", "");
    expect(screen.getByRole("button", { name: "正在同步模型…" })).toBeDisabled();
    expect(screen.queryByText("请选择模型")).toBeNull();
  });

  it("配置提示支持键盘打开设置", () => {
    const onOpenSettings = vi.fn();
    render(<Composer {...base} apiReady={false} onOpenSettings={onOpenSettings} />);
    fireEvent.keyDown(screen.getByRole("button", { name: "请先在「设置 → 模型」检查可用模型和连接" }), { key: "Enter" });
    expect(onOpenSettings).toHaveBeenCalledOnce();
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
    // 未创建的当前任务默认 ask → 触发器显示"请求批准"。
    render(<Composer {...base} showMeta onPlaceholder={vi.fn()} />);
    expect(screen.getByText(/请求批准/)).toBeInTheDocument();
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
    fireEvent.click(screen.getByRole("button", { name: "停止生成" }));
    expect(onCancel).toHaveBeenCalled();
  });

  it.each([
    ["补充要求", []],
    ["", ["/tmp/方案.docx"]],
    ["补充要求", ["/tmp/方案.docx"]],
  ])("编辑补充内容时仍可停止，保留正文和附件：%s %j", (draft, attachments) => {
    const onCancel = vi.fn().mockResolvedValue(false);
    const onEnqueue = vi.fn();
    const onSendNow = vi.fn();
    render(<Composer {...base} streaming onCancel={onCancel} onEnqueue={onEnqueue} onSendNow={onSendNow}
      externalText={draft} externalAttachments={attachments} externalTextNonce={1} />);
    expect(screen.getByRole("button", { name: "加入待发送队列" })).toBeEnabled();
    expect(screen.getAllByRole("button", { name: "停止生成" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "停止生成" }));
    expect(onCancel).toHaveBeenCalledExactlyOnceWith();
    expect(onEnqueue).not.toHaveBeenCalled();
    expect(onSendNow).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox")).toHaveValue(draft);
    if (attachments.length) expect(screen.getByText("方案.docx")).toBeInTheDocument();
  });

  it("streaming 时输入“中止”会执行本地停止，不会作为新 prompt 发送", async () => {
    const onControl = vi.fn().mockResolvedValue(true);
    const onSendNow = vi.fn();
    render(
      <Composer
        {...base}
        streaming
        onControl={onControl}
        onSendNow={onSendNow}
      />,
    );
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "中止" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: false });
    await waitFor(() => expect(onControl).toHaveBeenCalledWith("stop"));
    expect(onSendNow).not.toHaveBeenCalled();
    expect((input as HTMLTextAreaElement).value).toBe("");
  });

  it("streaming 时可用 Enter 中断当前回复并立即发送", async () => {
    const onSend = vi.fn();
    const onSendNow = vi.fn();
    render(<Composer {...base} streaming onSend={onSend} onSendNow={onSendNow} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "选择 2" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: false });
    await waitFor(() => expect(onSendNow).toHaveBeenCalledWith("选择 2", []));
    expect(onSend).not.toHaveBeenCalled();
    expect((input as HTMLTextAreaElement).value).toBe("");
  });

  it("结构化提问待回答时由问题卡片独占交互", () => {
    const onSendNow = vi.fn();
    render(
      <Composer
        {...base}
        streaming
        awaitingQuestion
        onSendNow={onSendNow}
        draft="保留的草稿"
        draftKey="s1"
      />,
    );
    const input = screen.getByRole("textbox");
    expect(input).toBeDisabled();
    expect(screen.queryByRole("button", { name: "中断当前回复并立即发送" })).toBeNull();
    expect((input as HTMLTextAreaElement).value).toBe("保留的草稿");
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

  it.each(["flush", "dream"])("记忆命令 /%s 由维护接口处理，不会误发给模型", async name => {
    const onSend = vi.fn();
    const onClientSlashCommand = vi.fn().mockResolvedValue(true);
    render(<Composer {...base} draft={`/${name}`} draftKey="s1" onSend={onSend} onClientSlashCommand={onClientSlashCommand} />);
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(onClientSlashCommand).toHaveBeenCalledWith({ name, args: "" }));
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox")).toHaveValue("");
  });

  it.each(["flush", "dream", "plan"])("多会话容器关闭 Slash 控制后，/%s 保留为消息内容", async name => {
    const onSend = vi.fn();
    const onClientSlashCommand = vi.fn();
    const onToast = vi.fn();
    render(<Composer {...base} slashCommandsEnabled={false} draft={`/${name}`} draftKey="group:one"
      onSend={onSend} onClientSlashCommand={onClientSlashCommand} onToast={onToast} />);
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith(`/${name}`, []));
    expect(onClientSlashCommand).not.toHaveBeenCalled();
    expect(onToast).not.toHaveBeenCalledWith(expect.stringContaining(`/${name}`));
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

  // ---------- 已选专家取消 ----------
  it("activeExpertName + onDismissExpert 时顶部 chip 与底部 footer 各渲染一个移除按钮", () => {
    const onDismissExpert = vi.fn();
    render(
      <Composer
        {...base}
        activeExpertName="小坦克"
        onDismissExpert={onDismissExpert}
      />,
    );
    // 同一 aria-label 出现两次:顶部 chip 与底部 footer badge 各一。
    expect(screen.getAllByRole("button", { name: "移除已选专家" })).toHaveLength(2);
  });

  it("点击顶部 chip 的移除按钮触发 onDismissExpert 且不影响输入框文本", () => {
    const onDismissExpert = vi.fn();
    render(
      <Composer
        {...base}
        activeExpertName="小坦克"
        draft="已预填的 quickPrompt"
        draftKey="s1"
        onDismissExpert={onDismissExpert}
      />,
    );
    const removeButtons = screen.getAllByRole("button", { name: "移除已选专家" });
    // 顶部 chip 是第一个(按 DOM 顺序出现在 footer 之前)。
    fireEvent.click(removeButtons[0]);
    expect(onDismissExpert).toHaveBeenCalledTimes(1);
    // 输入框文本保留:dismiss 只撤销专家身份,不破坏用户已输入/预填的内容。
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
      "已预填的 quickPrompt",
    );
  });

  it("点击底部 footer 的移除按钮同样触发 onDismissExpert", () => {
    const onDismissExpert = vi.fn();
    render(
      <Composer
        {...base}
        activeExpertName="小坦克"
        onDismissExpert={onDismissExpert}
      />,
    );
    const removeButtons = screen.getAllByRole("button", { name: "移除已选专家" });
    // 底部 footer badge 是第二个。
    fireEvent.click(removeButtons[1]);
    expect(onDismissExpert).toHaveBeenCalledTimes(1);
  });

  it("未传 onDismissExpert 时仍显示徽标,不抛错(向下兼容旧调用方)", () => {
    expect(() =>
      render(<Composer {...base} activeExpertName="小坦克" />),
    ).not.toThrow();
    // 没有移除按钮 — 旧路径下行为不变。
    expect(screen.queryByRole("button", { name: "移除已选专家" })).toBeNull();
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

it("输入卡空白可聚焦，按钮和已有选区保持各自交互", () => {
  const {container} = render(<Composer {...base} />);
  const input = screen.getByRole("textbox") as HTMLTextAreaElement;
  const card = container.querySelector(".echo-composer")!;
  fireEvent.click(card);
  expect(input).toHaveFocus();
  fireEvent.change(input, {target:{value:"保留选中的中文"}});
  input.setSelectionRange(0, 2);
  input.blur();
  fireEvent.click(card);
  expect(input).not.toHaveFocus();
  expect(input.selectionStart).toBe(0);
  expect(input.selectionEnd).toBe(2);
});

it("中文组合输入 Enter 不发送，Shift+Enter 不发送", () => {
  const onSend = vi.fn();
  render(<Composer {...base} onSend={onSend} />);
  const input = screen.getByRole("textbox");
  fireEvent.change(input, {target:{value:"中文输入"}});
  fireEvent.keyDown(input, {key:"Enter", isComposing:true});
  fireEvent.keyDown(input, {key:"Enter", shiftKey:true});
  expect(onSend).not.toHaveBeenCalled();
});

it("WebView2 组合状态与最终 229 Enter 都不误发送或选择命令", () => {
  const onSend = vi.fn();
  render(<Composer {...base} onSend={onSend} />);
  const input = screen.getByRole("textbox");
  fireEvent.change(input, {target:{value:"中文候选"}});
  fireEvent.compositionStart(input);
  fireEvent.keyDown(input, {key:"Enter", isComposing:false});
  fireEvent.compositionEnd(input);
  fireEvent.keyDown(input, {key:"Enter", keyCode:229});
  expect(onSend).not.toHaveBeenCalled();
  fireEvent.keyDown(input, {key:"Enter"});
  expect(onSend).toHaveBeenCalledWith("中文候选", []);
});
