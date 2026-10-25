import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/ModelSelector", () => ({ ModelSelector: ({ disabled }: { disabled: boolean }) => <button data-testid="model-selector" disabled={disabled}>模型</button> }));
vi.mock("@/components/PermissionPicker", () => ({ PermissionPicker: () => <div data-testid="permission-picker" /> }));

import { TheiaAgentComposer } from "../agent/TheiaAgentComposer";
import { useAiDraftStore } from "../store/ai-draft-store";
import type { CodingTask } from "../lib/types";

const task: CodingTask = {
  schemaVersion: 2, id: "task-1", name: "订单导出", requirement: "实现导出", phase: "implementing", sessionId: "session-1",
  acceptanceCriteria: [], taskNodes: [], planIssues: [], globalConstraints: [], createdAt: "", updatedAt: "",
};

function props(overrides: Partial<Parameters<typeof TheiaAgentComposer>[0]> = {}) {
  return {
    workspaceRoot: "/repo", task: null, sessionId: null, models: [{ id: "model-1" }], modelId: "model-1",
    contextPaths: [], apiReady: true, starting: false, sending: false, streaming: false,
    onModelChange: vi.fn(), onStart: vi.fn(), onSend: vi.fn(async () => true),
    onRemoveContext: vi.fn(), onDraftContextPaths: vi.fn(), ...overrides,
  };
}

beforeEach(() => {
  localStorage.clear();
  useAiDraftStore.getState().clear();
});

describe("TheiaAgentComposer", () => {
  it.each(["streaming", "verifying"])("Enter queues during %s without starting another coding turn", async phase => {
    const onEnqueue=vi.fn(()=>true), input=props({task:{...task,phase:phase === "verifying" ? "verifying" : "implementing"},sessionId:"session-1",streaming:phase === "streaming",sending:phase === "streaming",onEnqueue,contextPaths:["/repo/a.ts"]});
    const view=render(<TheiaAgentComposer {...input} />);
    const editor=screen.getByRole("textbox",{name:"补充开发要求"});
    fireEvent.change(editor,{target:{value:"补充边界测试"}}); fireEvent.keyDown(editor,{key:"Enter"});
    expect(onEnqueue).toHaveBeenCalledExactlyOnceWith("补充边界测试",["/repo/a.ts"]);
    expect(input.onSend).not.toHaveBeenCalled();
    await waitFor(()=>expect(editor).toHaveValue(""));
    view.rerender(<TheiaAgentComposer {...input} awaitingDecision />);
    expect(editor).toBeDisabled();
    expect(screen.getByRole("button",{name:"加入待发送队列"})).toBeDisabled();
  });

  it("starts a task from the bottom composer and keeps its text on a failed start", async () => {
    const input = props({ startError: "启动失败" });
    render(<TheiaAgentComposer {...input} />);
    fireEvent.change(screen.getByRole("textbox", { name: "任务描述" }), { target: { value: "实现订单导出" } });
    fireEvent.click(screen.getByRole("button", { name: "开始 Agent 任务" }));
    expect(input.onStart).toHaveBeenCalledWith("实现订单导出");
    await waitFor(() => expect(screen.getByRole("button", { name: "开始 Agent 任务" })).toBeEnabled());
    expect(screen.getByRole("textbox", { name: "任务描述" })).toHaveValue("实现订单导出");
    expect(screen.getByRole("alert")).toHaveTextContent("启动失败");
  });

  it("does not create duplicate tasks while a start request is pending", async () => {
    let finish: (() => void) | undefined;
    const onStart = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    render(<TheiaAgentComposer {...props({ onStart })} />);
    fireEvent.change(screen.getByRole("textbox", { name: "任务描述" }), { target: { value: "新增导出" } });
    fireEvent.click(screen.getByRole("button", { name: "开始 Agent 任务" }));
    expect(screen.getByRole("button", { name: "开始 Agent 任务" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "开始 Agent 任务" }));
    expect(onStart).toHaveBeenCalledTimes(1);
    await act(async () => finish?.());
  });

  it("guides setup before allowing a task without an available model", () => {
    render(<TheiaAgentComposer {...props({ apiReady: false, modelId: undefined })} />);
    fireEvent.change(screen.getByRole("textbox", { name: "任务描述" }), { target: { value: "新增导出" } });
    expect(screen.getByRole("button", { name: "开始 Agent 任务" })).toBeDisabled();
    expect(screen.getByText(/尚未配置可用模型/)).toBeInTheDocument();
  });

  it("keeps a follow-up while streaming, then sends and clears it", async () => {
    const input = props({ task, sessionId: "session-1", streaming: true });
    const { rerender } = render(<TheiaAgentComposer {...input} />);
    fireEvent.change(screen.getByRole("textbox", { name: "补充开发要求" }), { target: { value: "修复边界条件" } });
    expect(screen.getByRole("button", { name: "发送给 Agent" })).toBeDisabled();
    rerender(<TheiaAgentComposer {...input} streaming={false} />);
    fireEvent.click(screen.getByRole("button", { name: "发送给 Agent" }));
    await waitFor(() => expect(input.onSend).toHaveBeenCalledWith("修复边界条件"));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "补充开发要求" })).toHaveValue(""));
  });

  it("accepts a queued file-context prompt without remounting", async () => {
    const input = props({ task, sessionId: "session-1", contextPaths: ["src/order.ts"] });
    render(<TheiaAgentComposer {...input} />);
    act(() => useAiDraftStore.getState().setDraft({ prompt: "解释这个文件", contextPaths: ["src/order.ts"], source: "context-menu" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "补充开发要求" })).toHaveValue("解释这个文件"));
    expect(input.onDraftContextPaths).toHaveBeenCalledWith(["src/order.ts"]);
    fireEvent.click(screen.getByRole("button", { name: "移除上下文 src/order.ts" }));
    expect(input.onRemoveContext).toHaveBeenCalledWith("src/order.ts");
  });

  it("Enter and Ctrl/Cmd+Enter send; Shift+Enter and IME confirmation do not submit", async () => {
    const input = props();
    render(<TheiaAgentComposer {...input} />);
    const editor = screen.getByRole("textbox", { name: "任务描述" });
    fireEvent.change(editor, { target: { value: "检查中文输入" } });
    fireEvent.keyDown(editor, { key: "Enter", shiftKey: true });
    fireEvent.keyDown(editor, { key: "Enter", metaKey: true, isComposing: true });
    fireEvent.keyDown(editor, { key: "Enter", ctrlKey: true, keyCode: 229 });
    expect(input.onStart).not.toHaveBeenCalled();
    fireEvent.keyDown(editor, { key: "Enter" });
    expect(input.onStart).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByRole("button", { name: "开始 Agent 任务" })).toBeEnabled());
    fireEvent.keyDown(editor, { key: "Enter", metaKey: true });
    expect(input.onStart).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.getByRole("button", { name: "开始 Agent 任务" })).toBeEnabled());
  });

  it("shows pending submission and keeps edits made before the accepted reply", async () => {
    let finish: ((accepted: boolean) => void) | undefined;
    const onSend = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    render(<TheiaAgentComposer {...props({ task, sessionId: "session-1", onSend })} />);
    const editor = screen.getByRole("textbox", { name: "补充开发要求" });
    fireEvent.change(editor, { target: { value: "第一条补充" } });
    fireEvent.click(screen.getByRole("button", { name: "发送给 Agent" }));
    expect(screen.getByRole("button", { name: "发送给 Agent" })).toHaveAttribute("aria-busy", "true");
    expect(screen.getByTestId("model-selector")).toBeDisabled();
    fireEvent.change(editor, { target: { value: "下一条草稿" } });
    await act(async () => finish?.(true));
    expect(editor).toHaveValue("下一条草稿");
    expect(screen.getByTestId("model-selector")).toBeEnabled();
  });

  it.each([false, new Error("临时发送失败")])("keeps a follow-up when submission is rejected or fails (%s)", async (result) => {
    const onToast = vi.fn();
    const input = props({ task, sessionId: "session-1", onToast, onSend: vi.fn(async () => {
      if (result instanceof Error) throw result;
      return result;
    }) });
    render(<TheiaAgentComposer {...input} />);
    fireEvent.change(screen.getByRole("textbox", { name: "补充开发要求" }), { target: { value: "保留草稿" } });
    fireEvent.click(screen.getByRole("button", { name: "发送给 Agent" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "发送给 Agent" })).toBeEnabled());
    expect(screen.getByRole("textbox", { name: "补充开发要求" })).toHaveValue("保留草稿");
    if (result instanceof Error) expect(onToast).toHaveBeenCalledWith("发送失败：临时发送失败");
  });

  it("verification and a mismatched session cannot send; verification still accepts drafts", () => {
    const input = props({ task: { ...task, phase: "verifying" }, sessionId: "session-1" });
    const { rerender } = render(<TheiaAgentComposer {...input} />);
    const editor = screen.getByRole("textbox", { name: "补充开发要求" });
    fireEvent.change(editor, { target: { value: "验证后发送" } });
    expect(editor).toBeEnabled();
    expect(screen.getByRole("button", { name: "发送给 Agent" })).toBeDisabled();
    rerender(<TheiaAgentComposer {...input} sessionId="unrelated-session" />);
    expect(editor).toBeDisabled();
    expect(screen.getByTestId("model-selector")).toBeDisabled();
    expect(input.onSend).not.toHaveBeenCalled();
  });
});
