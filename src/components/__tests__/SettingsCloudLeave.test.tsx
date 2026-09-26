// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "../ThemeProvider";

vi.mock("../CloudStoragePanel", () => ({
  CloudStoragePanel: ({ onUnsavedChange }: { onUnsavedChange?: (dirty: boolean) => void }) => (
    <button type="button" onClick={() => onUnsavedChange?.(true)}>模拟修改云端文件</button>
  ),
}));

import { SettingsPanel } from "../SettingsPanel";

describe("SettingsPanel cloud editing guard", () => {
  it("关闭或切换页面前要求确认未保存的云端文件修改", async () => {
    const onClose = vi.fn();
    render(<ThemeProvider><SettingsPanel open initialSection="cloud-storage" onClose={onClose} /></ThemeProvider>);
    fireEvent.click(screen.getByRole("button", { name: "模拟修改云端文件" }));
    fireEvent.click(screen.getByRole("button", { name: "关闭设置" }));
    const dialog = await screen.findByRole("alertdialog", { name: "舍弃云端文件未保存的修改？" });
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "个性化" }));
    const switchDialog = await screen.findByRole("alertdialog", { name: "舍弃云端文件未保存的修改？" });
    fireEvent.click(within(switchDialog).getByRole("button", { name: "舍弃修改" }));
    expect(await screen.findByRole("heading", { name: "个性化" })).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});
