import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { VerificationView } from "../panels/VerificationView";

describe("VerificationView RED checkpoint", () => {
  it("offers only the expected-failure test run until RED is recorded", async () => {
    const command = { command: "pnpm test", kind: "test" as const, label: "测试", requiresApproval: true };
    const onRunRed = vi.fn();
    render(<VerificationView records={[]} detected={[command]} running={false} hasTask redCheckpoint onRun={vi.fn()} onRunAll={vi.fn()} onRunRed={onRunRed} onOpenOutput={vi.fn()} />);

    expect(screen.getByRole("button", { name: "运行全部验证" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "需要确认测试" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "运行 RED · 测试" }));
    expect(onRunRed).toHaveBeenCalledWith(command);
  });
});
