import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Composer } from "../Composer";

// Tauri shell 接口被 Composer 调用,这里集中拦截以驱动 paste / drop 流程。
// Tauri 2 真实的 `onDragDropEvent` 回调收到的是 `event.payload = { type, paths?, position? }`,
// 所以测试也按真实结构喂事件。
type DragDropPayload =
  | { type: "enter"; paths: string[]; position: { x: number; y: number } }
  | { type: "over"; position: { x: number; y: number } }
  | { type: "drop"; paths: string[]; position: { x: number; y: number } }
  | { type: "leave" };

let dragDropCallback: ((event: { payload: DragDropPayload }) => void) | null = null;
const unlistenMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: { suggestedName?: string; mime?: string }) => {
    if (cmd === "save_attachment_blob") {
      // 保留 suggestedName 原值,这样 chip 显示的 basename 跟测试期望一致。
      return `/fake/appdata/clipboard-images/${args.suggestedName ?? "image.png"}`;
    }
    return undefined;
  }),
}));

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: (cb: (event: { payload: DragDropPayload }) => void) => {
      dragDropCallback = cb;
      return Promise.resolve(() => unlistenMock());
    },
  }),
}));

const base = { streaming: false, onSend: vi.fn(), onCancel: vi.fn() };

function makeImageFile(name: string): File {
  return new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, { type: "image/png" });
}

/**
 * jsdom 不支持 ClipboardEvent 构造器。testing-library/dom v10 已经知道这点
 * (events.js:76-97),会把 init.clipboardData 通过 defineProperty 注入到事件
 * 实例上,所以这里直接传 { clipboardData } 即可。
 */
function firePasteWith(
  target: HTMLElement,
  items: Array<{ kind: string; type: string; getAsFile(): File | Blob | null }>,
) {
  fireEvent.paste(target, {
    clipboardData: { items: items as unknown as DataTransferItemList },
  });
}

describe("Composer clipboard paste of images", () => {
  beforeEach(() => {
    dragDropCallback = null;
  });

  it("pasting an image calls save_attachment_blob and adds it to attachments", async () => {
    render(<Composer {...base} />);
    const textarea = screen.getByRole("textbox");
    firePasteWith(textarea, [
      { kind: "file", type: "image/png", getAsFile: () => makeImageFile("shot.png") },
    ]);
    expect(await screen.findByText("shot.png")).toBeInTheDocument();
  });

  it("pasting multiple images at once adds all of them", async () => {
    render(<Composer {...base} />);
    const textarea = screen.getByRole("textbox");
    firePasteWith(textarea, [
      { kind: "file", type: "image/png", getAsFile: () => makeImageFile("a.png") },
      { kind: "file", type: "image/jpeg", getAsFile: () => makeImageFile("b.jpg") },
    ]);
    expect(await screen.findByText("a.png")).toBeInTheDocument();
    expect(await screen.findByText("b.jpg")).toBeInTheDocument();
  });

  it("pasting a non-image file does not add it as attachment", () => {
    render(<Composer {...base} />);
    const textarea = screen.getByRole("textbox");
    firePasteWith(textarea, [
      {
        kind: "file",
        type: "application/pdf",
        getAsFile: () => new File(["pdf"], "x.pdf", { type: "application/pdf" }),
      },
    ]);
    expect(screen.queryByText("x.pdf")).toBeNull();
  });

  it("pasting mixed text + image keeps the textarea content unchanged and adds the image", async () => {
    render(<Composer {...base} />);
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "看一下这张图" } });
    firePasteWith(textarea, [
      { kind: "file", type: "image/png", getAsFile: () => makeImageFile("ctx.png") },
    ]);
    expect(await screen.findByText("ctx.png")).toBeInTheDocument();
    // jsdom 不会模拟默认粘贴到 textarea 的行为,所以这里只断言处理器不破坏现有内容。
    expect(textarea.value).toBe("看一下这张图");
  });

  it("save_attachment_blob failure surfaces a toast and adds nothing", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const onToast = vi.fn();
    (invoke as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      throw new Error("disk full");
    });
    render(<Composer {...base} onToast={onToast} />);
    const textarea = screen.getByRole("textbox");
    firePasteWith(textarea, [
      { kind: "file", type: "image/png", getAsFile: () => makeImageFile("fail.png") },
    ]);
    await waitFor(() => expect(onToast).toHaveBeenCalled());
    expect(screen.queryByText("fail.png")).toBeNull();
  });
});

describe("Composer drag-drop via Tauri native event", () => {
  beforeEach(() => {
    dragDropCallback = null;
  });

  it("registers onDragDropEvent listener on mount and unlistens on unmount", async () => {
    const { unmount } = render(<Composer {...base} />);
    // Effect is flushed synchronously by testing-library after render.
    expect(dragDropCallback).not.toBeNull();
    unmount();
    expect(unlistenMock).toHaveBeenCalled();
  });

  it("drop with image paths adds them as attachments", async () => {
    render(<Composer {...base} />);
    expect(dragDropCallback).not.toBeNull();
    act(() => {
      dragDropCallback!({
        payload: {
          type: "drop",
          paths: ["/Users/me/Pictures/a.png", "/Users/me/Pictures/b.jpg"],
          position: { x: 0, y: 0 },
        },
      });
    });
    expect(await screen.findByText("a.png")).toBeInTheDocument();
    expect(await screen.findByText("b.jpg")).toBeInTheDocument();
  });

  it("drop ignores non-image files", () => {
    render(<Composer {...base} />);
    expect(dragDropCallback).not.toBeNull();
    act(() => {
      dragDropCallback!({
        payload: {
          type: "drop",
          paths: ["/Users/me/notes.txt", "/Users/me/code.ts"],
          position: { x: 0, y: 0 },
        },
      });
    });
    expect(screen.queryByText("notes.txt")).toBeNull();
    expect(screen.queryByText("code.ts")).toBeNull();
  });

  it("drag-hover shows the drop overlay", () => {
    render(<Composer {...base} />);
    expect(dragDropCallback).not.toBeNull();
    act(() => {
      dragDropCallback!({
        payload: { type: "enter", paths: [], position: { x: 0, y: 0 } },
      });
    });
    expect(screen.getByText("松开以添加为附件")).toBeInTheDocument();
  });

  it("drag-leave hides the drop overlay", async () => {
    render(<Composer {...base} />);
    expect(dragDropCallback).not.toBeNull();
    act(() => {
      dragDropCallback!({
        payload: { type: "enter", paths: [], position: { x: 0, y: 0 } },
      });
    });
    expect(screen.getByText("松开以添加为附件")).toBeInTheDocument();
    act(() => {
      dragDropCallback!({ payload: { type: "leave" } });
    });
    await waitFor(() => {
      expect(screen.queryByText("松开以添加为附件")).toBeNull();
    });
  });
});