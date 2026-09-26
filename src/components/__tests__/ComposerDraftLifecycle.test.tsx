import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Composer } from "../Composer";
import { HomePage } from "../HomePage";
import { HOME_DRAFT_KEY, useSessionsStore } from "@/stores/sessions-store";
import { usePendingExpertStore } from "@/stores/pending-expert-store";
import { draftAttachments, saveDraftAttachments } from "@/lib/draft-attachments";
import { registerAsrProvider, resetVoiceRegistry, type AsrProvider } from "@/lib/voice-contract";

const base = { streaming: false, apiReady: true, onCancel: vi.fn(), onSend: vi.fn() };
function StoredComposer({ scope, onSend = base.onSend }: { scope: string; onSend?: typeof base.onSend }) {
  const draft = useSessionsStore(state => state.drafts[scope] ?? "");
  return <Composer {...base} onSend={onSend} draft={draft} draftKey={scope}
    onDraftChange={text => useSessionsStore.getState().setDraft(scope, text)} />;
}
function deferredSend() {
  let resolve!: (accepted: boolean) => void;
  const onSend = vi.fn(() => new Promise<boolean>(accept => { resolve = accept; }));
  return { onSend, accept: async (value = true) => { await act(async () => resolve(value)); } };
}

beforeEach(() => {
  localStorage.clear();
  useSessionsStore.setState({ independent: [], drafts: {}, currentSessionId: null, pendingSessionPatches: {} });
  usePendingExpertStore.setState({ expert: null });
});
afterEach(() => { cleanup(); resetVoiceRegistry(); });

describe("composer draft lifecycle", () => {
  it("keeps a home draft across repeated visits, including its persisted copy", () => {
    useSessionsStore.getState().setDraft(HOME_DRAFT_KEY, "尚未发送的需求");
    const props = { ...base, onOpenSettings: vi.fn(), onPlaceholder: vi.fn() };
    const view = render(<HomePage {...props} />);
    expect(screen.getByRole("textbox")).toHaveValue("尚未发送的需求");
    expect(useSessionsStore.getState().drafts[HOME_DRAFT_KEY]).toBe("尚未发送的需求");
    view.unmount();
    render(<HomePage {...props} />);
    expect(screen.getByRole("textbox")).toHaveValue("尚未发送的需求");
  });

  it("an explicit template command wins over initial restoration and persists", () => {
    useSessionsStore.getState().setDraft("s1", "旧内容");
    render(<Composer {...base} draft="旧内容" draftKey="s1" externalText="新模板" externalTextNonce={1}
      onDraftChange={text => useSessionsStore.getState().setDraft("s1", text)} />);
    expect(screen.getByRole("textbox")).toHaveValue("新模板");
    expect(useSessionsStore.getState().drafts.s1).toBe("新模板");
  });

  it("external reset clears visible text and attachment references in the same scope", async () => {
    useSessionsStore.getState().setDraft("s1", "旧内容");
    saveDraftAttachments("s1", ["/work/report.txt"]);
    render(<StoredComposer scope="s1" />);
    expect(screen.getByText("report.txt")).toBeInTheDocument();
    act(() => useSessionsStore.getState().clearDraft("s1"));
    expect(screen.getByRole("textbox")).toHaveValue("");
    await waitFor(() => expect(screen.queryByText("report.txt")).toBeNull());
    expect(draftAttachments("s1")).toEqual([]);
  });

  it("normal edits preserve the selection while updating durable text", () => {
    render(<StoredComposer scope="s1" />);
    const input = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "abcdef" } });
    input.setSelectionRange(2, 4);
    act(() => useSessionsStore.getState().setQuery("another state change"));
    expect([input.selectionStart, input.selectionEnd]).toEqual([2, 4]);
    expect(useSessionsStore.getState().drafts.s1).toBe("abcdef");
  });

  it("accepted send consumes its text and attachments after unmount", async () => {
    useSessionsStore.getState().setDraft(HOME_DRAFT_KEY, "已提交");
    saveDraftAttachments(HOME_DRAFT_KEY, ["/work/a.txt"]);
    const pending = deferredSend();
    const view = render(<StoredComposer scope={HOME_DRAFT_KEY} onSend={pending.onSend} />);
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    view.unmount();
    await pending.accept();
    expect(useSessionsStore.getState().drafts[HOME_DRAFT_KEY]).toBeUndefined();
    expect(draftAttachments(HOME_DRAFT_KEY)).toEqual([]);
  });

  it.each(["新需求", "已提交"])("late acceptance preserves a newer home revision (%s)", async next => {
    useSessionsStore.getState().setDraft(HOME_DRAFT_KEY, "已提交");
    const pending = deferredSend();
    const view = render(<StoredComposer scope={HOME_DRAFT_KEY} onSend={pending.onSend} />);
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    view.unmount();
    useSessionsStore.getState().setDraft(HOME_DRAFT_KEY, "编辑中");
    useSessionsStore.getState().setDraft(HOME_DRAFT_KEY, next);
    saveDraftAttachments(HOME_DRAFT_KEY, ["/work/new.txt"]);
    render(<StoredComposer scope={HOME_DRAFT_KEY} />);
    await pending.accept();
    expect(screen.getByRole("textbox")).toHaveValue(next);
    expect(draftAttachments(HOME_DRAFT_KEY)).toEqual(["/work/new.txt"]);
  });

  it("consumes an unchanged submission after switching away and back", async () => {
    useSessionsStore.getState().setDraft("s1", "待确认发送");
    const pending = deferredSend();
    const view = render(<StoredComposer scope="s1" onSend={pending.onSend} />);
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    view.rerender(<StoredComposer scope="s2" />);
    view.rerender(<StoredComposer scope="s1" />);
    await pending.accept();
    expect(screen.getByRole("textbox")).toHaveValue("");
    expect(useSessionsStore.getState().drafts.s1).toBeUndefined();
  });

  it("an old submission cannot unlock a pending submission in another task", async () => {
    useSessionsStore.getState().setDraft("s1", "任务一");
    useSessionsStore.getState().setDraft("s2", "任务二");
    const first = deferredSend();
    const second = deferredSend();
    const view = render(<StoredComposer scope="s1" onSend={first.onSend} />);
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    view.rerender(<StoredComposer scope="s2" onSend={second.onSend} />);
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await first.accept();
    expect(screen.getByRole("textbox")).toHaveValue("任务二");
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    await second.accept(false);
    expect(screen.getByRole("button", { name: "发送" })).toBeEnabled();
  });

  it("stops voice input on task switches and ignores late recognition results", () => {
    let handlers!: Parameters<AsrProvider["listen"]>[1];
    const stop = vi.fn();
    registerAsrProvider({ id: "draft-test", isAvailable: () => true, listen: (_, callbacks) => {
      handlers = callbacks;
      return stop;
    } });
    const view = render(<StoredComposer scope="s1" />);
    fireEvent.click(screen.getByRole("button", { name: "语音输入" }));
    act(() => handlers.onInterim?.("任务一语音"));
    expect(screen.getByRole("textbox")).toHaveValue("任务一语音");
    view.rerender(<StoredComposer scope="s2" />);
    expect(stop).toHaveBeenCalledOnce();
    act(() => handlers.onFinal?.("迟到结果"));
    expect(screen.getByRole("textbox")).toHaveValue("");
    expect(screen.getByRole("button", { name: "语音输入" })).toHaveAttribute("title", "语音输入");
  });

  it("changing only attachments during submission keeps the revised draft", async () => {
    useSessionsStore.getState().setDraft("s1", "内容");
    const pending = deferredSend();
    render(<StoredComposer scope="s1" onSend={pending.onSend} />);
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    act(() => saveDraftAttachments("s1", ["/work/new.txt"]));
    await pending.accept();
    expect(screen.getByRole("textbox")).toHaveValue("内容");
    expect(screen.getByText("new.txt")).toBeInTheDocument();
  });

  it("rejected submissions preserve content and attachments across navigation", async () => {
    useSessionsStore.getState().setDraft("s1", "重试内容");
    saveDraftAttachments("s1", ["/work/a.txt"]);
    const pending = deferredSend();
    const view = render(<StoredComposer scope="s1" onSend={pending.onSend} />);
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    view.unmount();
    await pending.accept(false);
    render(<StoredComposer scope="s1" />);
    expect(screen.getByRole("textbox")).toHaveValue("重试内容");
    expect(screen.getByText("a.txt")).toBeInTheDocument();
  });

  it("deletion clears an uncatalogued task's draft and attachments, preserving other drafts", () => {
    const store = useSessionsStore.getState();
    store.setDraft("deleted", "已删除任务");
    saveDraftAttachments("deleted", ["/work/a.txt"]);
    store.setDraft(HOME_DRAFT_KEY, "独立的新任务");
    store.setDraft("other", "其他任务");
    store.remove("deleted");
    expect(useSessionsStore.getState().drafts).toEqual({ [HOME_DRAFT_KEY]: "独立的新任务", other: "其他任务" });
    expect(draftAttachments("deleted")).toEqual([]);
  });

  it("switching sessions restores only that session and clears input recall history", () => {
    const onSend = vi.fn();
    const view = render(<StoredComposer scope="s1" onSend={onSend} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "任务 A 私有内容" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    view.rerender(<StoredComposer scope="s2" onSend={onSend} />);
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "ArrowUp" });
    expect(screen.getByRole("textbox")).toHaveValue("");
  });
});
