import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Composer } from "../Composer";
import { invoke } from "@tauri-apps/api/core";

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

function makeSizedImage(name: string, size: number, arrayBuffer = vi.fn()) {
  return {
    name,
    size,
    type: "image/png",
    arrayBuffer,
  } as unknown as Blob;
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
    vi.mocked(invoke).mockClear();
    base.onSend.mockReset();
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
    const onToast = vi.fn();
    vi.mocked(invoke).mockImplementationOnce(async () => {
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

  it("单张图片超过 20MB 时在读取二进制前拒绝", () => {
    const onToast = vi.fn();
    const arrayBuffer = vi.fn();
    render(<Composer {...base} onToast={onToast} />);

    firePasteWith(screen.getByRole("textbox"), [
      {
        kind: "file",
        type: "image/png",
        getAsFile: () => makeSizedImage("large.png", 20 * 1024 * 1024 + 1, arrayBuffer),
      },
    ]);

    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalledWith("save_attachment_blob", expect.anything());
    expect(onToast).toHaveBeenCalledWith(expect.stringContaining("超过 20MB"));
  });

  it("一次粘贴超过 20 个附件时不读取文件", () => {
    const onToast = vi.fn();
    const arrayBuffer = vi.fn();
    render(<Composer {...base} onToast={onToast} />);
    const items = Array.from({ length: 21 }, (_, index) => ({
      kind: "file",
      type: "image/png",
      getAsFile: () => makeSizedImage(`image-${index}.png`, 1, arrayBuffer),
    }));

    firePasteWith(screen.getByRole("textbox"), items);

    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(onToast).toHaveBeenCalledWith("附件数量不能超过 20 个");
  });

  it("一次粘贴总大小超过 64MB 时不读取文件", () => {
    const onToast = vi.fn();
    const arrayBuffer = vi.fn();
    render(<Composer {...base} onToast={onToast} />);
    const items = Array.from({ length: 4 }, (_, index) => ({
      kind: "file",
      type: "image/png",
      getAsFile: () => makeSizedImage(`image-${index}.png`, 17 * 1024 * 1024, arrayBuffer),
    }));

    firePasteWith(screen.getByRole("textbox"), items);

    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(onToast).toHaveBeenCalledWith("本次粘贴的图片总大小不能超过 64MB");
  });

  it("并发粘贴完成时仍严格限制为 20 个附件", async () => {
    const onToast = vi.fn();
    render(<Composer {...base} onToast={onToast} />);
    const textarea = screen.getByRole("textbox");
    const makeItems = (prefix: string) => Array.from({ length: 11 }, (_, index) => ({
      kind: "file",
      type: "image/png",
      getAsFile: () => makeImageFile(`${prefix}-${index}.png`),
    }));

    firePasteWith(textarea, makeItems("first"));
    firePasteWith(textarea, makeItems("second"));

    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: "移除附件" })).toHaveLength(20);
    });
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("discard_attachment_blob", expect.objectContaining({
        path: expect.stringContaining(".png"),
      }));
    });
    expect(onToast).toHaveBeenCalledWith(expect.stringContaining("已忽略多余图片"));
  });

  it("移除未发送的粘贴图片时删除临时文件", async () => {
    render(<Composer {...base} />);
    firePasteWith(screen.getByRole("textbox"), [
      { kind: "file", type: "image/png", getAsFile: () => makeImageFile("remove.png") },
    ]);

    await screen.findByText("remove.png");
    fireEvent.click(screen.getByRole("button", { name: "移除附件" }));

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("discard_attachment_blob", {
        path: "/fake/appdata/clipboard-images/remove.png",
      });
    });
  });

  it("组件卸载时清理未发送的粘贴图片", async () => {
    const view = render(<Composer {...base} />);
    firePasteWith(screen.getByRole("textbox"), [
      { kind: "file", type: "image/png", getAsFile: () => makeImageFile("draft.png") },
    ]);
    await screen.findByText("draft.png");

    view.unmount();

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("discard_attachment_blob", {
        path: "/fake/appdata/clipboard-images/draft.png",
      });
    });
  });

  it("历史消息恢复的附件移除时不删除原文件", async () => {
    render(
      <Composer
        {...base}
        externalText="重新发送"
        externalAttachments={["/fake/appdata/clipboard-images/history.png"]}
        externalTextNonce={1}
      />,
    );
    await screen.findByText("history.png");
    vi.mocked(invoke).mockClear();

    fireEvent.click(screen.getByRole("button", { name: "移除附件" }));

    expect(invoke).not.toHaveBeenCalledWith("discard_attachment_blob", expect.anything());
  });

  it("发送成功后保留已转交给会话的粘贴图片", async () => {
    base.onSend.mockResolvedValue(true);
    render(<Composer {...base} />);
    firePasteWith(screen.getByRole("textbox"), [
      { kind: "file", type: "image/png", getAsFile: () => makeImageFile("sent.png") },
    ]);
    await screen.findByText("sent.png");
    vi.mocked(invoke).mockClear();

    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => expect(base.onSend).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText("sent.png")).not.toBeInTheDocument());
    expect(invoke).not.toHaveBeenCalledWith("discard_attachment_blob", expect.anything());
  });

  it("发送被拒绝后保留附件，之后移除仍会清理临时文件", async () => {
    base.onSend.mockResolvedValue(false);
    render(<Composer {...base} />);
    firePasteWith(screen.getByRole("textbox"), [
      { kind: "file", type: "image/png", getAsFile: () => makeImageFile("retry.png") },
    ]);
    await screen.findByText("retry.png");
    vi.mocked(invoke).mockClear();

    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(base.onSend).toHaveBeenCalled());
    expect(screen.getByText("retry.png")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "移除附件" }));
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("discard_attachment_blob", {
        path: "/fake/appdata/clipboard-images/retry.png",
      });
    });
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
