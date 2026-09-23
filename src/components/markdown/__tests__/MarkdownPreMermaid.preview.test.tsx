import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MarkdownPreMermaid } from "../MarkdownPreMermaid";

const graph = "flowchart LR\nA-->B";
const svg = '<svg viewBox="0 0 2400 400" xmlns="http://www.w3.org/2000/svg"></svg>';

vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async () => ({ svg })),
  },
}));

describe("Mermaid 图表预览", () => {
  const originalCreate = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
  const originalRevoke = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");

  beforeEach(() => {
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:diagram") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  });

  afterEach(() => {
    cleanup();
    if (originalCreate) Object.defineProperty(URL, "createObjectURL", originalCreate);
    else Reflect.deleteProperty(URL, "createObjectURL");
    if (originalRevoke) Object.defineProperty(URL, "revokeObjectURL", originalRevoke);
    else Reflect.deleteProperty(URL, "revokeObjectURL");
  });

  it("单击图表可在应用内预览，并以原始逻辑尺寸查看宽图", async () => {
    render(<MarkdownPreMermaid content={graph} />);
    const trigger = await screen.findByRole("button", { name: "放大预览图表" });
    fireEvent.click(trigger);

    const dialog = screen.getByRole("dialog", { name: "图表预览" });
    const image = within(dialog).getByRole("img");
    expect(image).toHaveAttribute("src", "blob:diagram");
    expect(dialog.querySelector("svg")).toBeNull();

    fireEvent.click(within(dialog).getByRole("button", { name: "原始大小" }));
    expect(image).toHaveStyle({ width: "2400px", height: "400px" });
    fireEvent.click(within(dialog).getByRole("button", { name: "放大图片" }));
    expect(image).toHaveStyle({ width: "3000px", height: "500px" });
    fireEvent.click(within(dialog).getByRole("button", { name: "适应窗口" }));
    expect(within(dialog).getByRole("button", { name: "适应窗口" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "图表预览" })).toBeNull();
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(screen.getByRole("button", { name: "放大" }));
    expect(screen.getByRole("dialog", { name: "图表预览" })).toBeInTheDocument();
  });

  it("保留宿主提供的预览回调", async () => {
    const onPreviewMermaid = vi.fn();
    render(<MarkdownPreMermaid content={graph} onPreviewMermaid={onPreviewMermaid} />);
    await screen.findByRole("button", { name: "放大预览图表" });
    fireEvent.click(screen.getByRole("button", { name: "放大" }));
    expect(onPreviewMermaid).toHaveBeenCalledWith(svg, graph);
    expect(screen.queryByRole("dialog", { name: "图表预览" })).toBeNull();
  });
});
