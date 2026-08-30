// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

vi.mock("@/lib/agent-client", () => ({
  providersList: vi.fn().mockResolvedValue({ providers: [], models: [] }),
  notificationList: vi.fn().mockResolvedValue([]),
  notificationMarkRead: vi.fn().mockResolvedValue(undefined),
  notificationMarkAllRead: vi.fn().mockResolvedValue(undefined),
  notificationClear: vi.fn().mockResolvedValue(undefined),
}));

import { SettingsPanel } from "../SettingsPanel";

describe("SettingsPanel", () => {
  it("移除助理设置，并将智能体邮箱统一显示为通知中心", async () => {
    render(<SettingsPanel open onClose={() => {}} />);

    expect(screen.queryByRole("button", { name: "助理设置" })).not.toBeInTheDocument();
    expect(screen.queryByText("智能体邮箱")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "通知中心" }));
    expect(await screen.findByRole("heading", { name: "通知中心" })).toBeInTheDocument();
  });
});
