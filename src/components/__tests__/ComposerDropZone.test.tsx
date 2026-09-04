import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Composer } from "../Composer";

const base = { streaming: false, onSend: vi.fn(), onCancel: vi.fn() };

describe("Composer attachment authorization", () => {
  it("不再展示无法建立 native grant 的拖放入口", () => {
    const { container } = render(<Composer {...base} />);

    fireEvent.dragEnter(container.querySelector(".echo-composer")!);

    expect(screen.queryByText("松开以添加文件到对话")).toBeNull();
    expect(container.querySelector(".echo-composer__dropzone")).toBeNull();
  });
});
