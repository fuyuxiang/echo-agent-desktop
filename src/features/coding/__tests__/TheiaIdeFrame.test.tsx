import { act, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TheiaIdeFrame, type TheiaIdeFrameHandle } from "../TheiaIdeFrame";

const invoke = vi.fn(async (_command: string, _args?: unknown) => ({ url: "http://127.0.0.1:41773/", embedToken: "embed-token" }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: (command: string, args: unknown) => invoke(command, args) }));

function sendFrameMessage(frame: HTMLIFrameElement, data: Record<string, unknown>) {
  const url = new URL(frame.src);
  act(() => {
    window.dispatchEvent(new MessageEvent("message", {
      origin: url.origin,
      source: frame.contentWindow,
      data: { ...data, token: url.searchParams.get("echoBridgeToken") },
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
});
