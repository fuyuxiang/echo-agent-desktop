import { act, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TheiaIdeFrame, type TheiaIdeFrameHandle } from "../TheiaIdeFrame";

const invoke = vi.fn(async (_command: string, _args?: unknown) => ({ url: "http://127.0.0.1:41773/", embedToken: "embed-token" }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: (command: string, args: unknown) => invoke(command, args) }));

function sendFrameMessage(frame: HTMLIFrameElement, data: Record<string, unknown>) {
  const url = new URL(frame.src);
  const { bridgeToken } = JSON.parse(frame.name.slice("echo-embed:".length)) as { bridgeToken: string };
  act(() => {
    window.dispatchEvent(new MessageEvent("message", {
      origin: url.origin,
      source: frame.contentWindow,
      data: { ...data, token: bridgeToken },
    }));
  });
}

describe("Theia IDE bridge", () => {
  beforeEach(() => invoke.mockClear());

  it("rejects every mutation whose path list includes a file outside the active project", async () => {
    const onBeforeMutation = vi.fn(async () => ({ taskId: "task-1", closeRound: false }));
    render(<TheiaIdeFrame root="/repo" onBeforeMutation={onBeforeMutation} onAfterMutation={vi.fn()} />);
    const frame = await screen.findByTitle("Echo Code IDE") as HTMLIFrameElement;
    const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");

    sendFrameMessage(frame, { type: "echo/before-mutation", id: "mixed", operation: "move", paths: ["/repo/a.ts", "/other/b.ts"] });
    await waitFor(() => expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ id: "mixed", ok: false }), new URL(frame.src).origin));
    expect(onBeforeMutation).not.toHaveBeenCalled();

    sendFrameMessage(frame, { type: "echo/before-mutation", id: "inside", operation: "write", paths: ["/repo/a.ts"] });
    await waitFor(() => expect(onBeforeMutation).toHaveBeenCalledWith("write", ["/repo/a.ts"]));
    await waitFor(() => expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ id: "inside", ok: true }), new URL(frame.src).origin));
  });

  it("reports Theia dirty files and waits for an acknowledged save before leaving", async () => {
    const ref = createRef<TheiaIdeFrameHandle>();
    const onDirtyChange = vi.fn();
    render(<TheiaIdeFrame ref={ref} root="/repo" onBeforeMutation={vi.fn()} onAfterMutation={vi.fn()} onDirtyChange={onDirtyChange} />);
    const frame = await screen.findByTitle("Echo Code IDE") as HTMLIFrameElement;
    const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");
    sendFrameMessage(frame, { type: "echo/ready" });
    sendFrameMessage(frame, { type: "echo/dirty-state", count: 2 });
    expect(onDirtyChange).toHaveBeenLastCalledWith(2);

    const dirty = ref.current!.getDirtyCount();
    await waitFor(() => expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "echo/get-dirty" }), new URL(frame.src).origin));
    const dirtyRequest = postMessage.mock.calls.find(([message]) => (message as { type?: string }).type === "echo/get-dirty")![0] as { id: string };
    sendFrameMessage(frame, { type: "echo/response", id: dirtyRequest.id, ok: true, value: 2 });
    await expect(dirty).resolves.toBe(2);

    const saved = ref.current!.saveAll();
    await waitFor(() => expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "echo/save-all" }), new URL(frame.src).origin));
    const saveRequest = postMessage.mock.calls.find(([message]) => (message as { type?: string }).type === "echo/save-all")![0] as { id: string };
    sendFrameMessage(frame, { type: "echo/response", id: saveRequest.id, ok: true, value: 0 });
    await expect(saved).resolves.toBe(true);
    expect(onDirtyChange).toHaveBeenLastCalledWith(0);
  });

  it("accepts only local preview URLs and symbols from the active workspace", async () => {
    const onPreviewUrl = vi.fn();
    const onActiveSymbol = vi.fn();
    render(<TheiaIdeFrame root="/repo" onBeforeMutation={vi.fn()} onAfterMutation={vi.fn()} onPreviewUrl={onPreviewUrl} onActiveSymbol={onActiveSymbol} />);
    const frame = await screen.findByTitle("Echo Code IDE") as HTMLIFrameElement;

    sendFrameMessage(frame, { type: "echo/active-symbol", path: "/other/a.ts", symbol: "run" });
    expect(onActiveSymbol).toHaveBeenLastCalledWith(null);
    sendFrameMessage(frame, { type: "echo/active-symbol", path: "/repo/a.ts", symbol: "run" });
    expect(onActiveSymbol).toHaveBeenLastCalledWith({ path: "/repo/a.ts", symbol: "run" });

    sendFrameMessage(frame, { type: "echo/preview-url", url: "https://example.com:5173/" });
    expect(onPreviewUrl).not.toHaveBeenCalled();
    sendFrameMessage(frame, { type: "echo/preview-url", url: "http://localhost:5173/" });
    expect(onPreviewUrl).toHaveBeenCalledWith("http://localhost:5173/");
  });

  it("starts a fresh iframe session when the project changes", async () => {
    const callbacks = { onBeforeMutation: vi.fn(), onAfterMutation: vi.fn() };
    const { rerender } = render(<TheiaIdeFrame root="/repo-one" {...callbacks} />);
    const first = await screen.findByTitle("Echo Code IDE") as HTMLIFrameElement;
    const firstToken = JSON.parse(first.name.slice("echo-embed:".length)).bridgeToken as string;

    rerender(<TheiaIdeFrame root="/repo-two" {...callbacks} />);
    const second = await screen.findByTitle("Echo Code IDE") as HTMLIFrameElement;
    await waitFor(() => expect(new URL(second.src).hash).toBe("#/repo-two"));
    expect(JSON.parse(second.name.slice("echo-embed:".length)).bridgeToken).not.toBe(firstToken);
    expect(invoke).toHaveBeenCalledWith("coding_theia_start", { root: "/repo-two" });
  });
});
