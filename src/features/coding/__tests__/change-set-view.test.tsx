import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ChangeSetView } from "../explorer/ChangeSetView";
import type { ChangeSet } from "../lib/types";

const changeSet: ChangeSet = {
  taskId: "task-1",
  baselineMode: "git",
  createdAt: "2026-09-24T00:00:00Z",
  reviewedFiles: [],
  changes: [
    { path: "src/task.ts", kind: "modified", added: 2, removed: 1, preExisting: false },
    { path: "src/other.ts", kind: "added", added: 3, removed: 0, preExisting: false },
    { path: "src/user.ts", kind: "modified", added: 1, removed: 1, preExisting: true },
  ],
};

describe("ChangeSetView", () => {
  it("commits only selected task files and keeps pre-existing changes protected", async () => {
    const onCommit = vi.fn();
    render(<ChangeSetView changeSet={changeSet} hasTask canCommit onCommit={onCommit} onOpenDiff={vi.fn()} onDiscard={vi.fn()} onRollback={vi.fn()} />);

    expect(screen.getByRole("checkbox", { name: "选择提交 src/user.ts" })).toBeDisabled();
    await userEvent.click(screen.getByRole("checkbox", { name: "选择提交 src/other.ts" }));
    await userEvent.click(screen.getByRole("button", { name: "提交选中 1 个文件" }));
    expect(onCommit).toHaveBeenCalledWith(["src/task.ts"], {});
  });

  it("lets the user submit a selected task hunk from a pre-existing dirty file", async () => {
    const onCommit = vi.fn();
    const onLoadHunks = vi.fn().mockResolvedValue([{ id: "hunk-1", preview: "@@ -2 +2 @@\n-old\n+task\n" }]);
    render(<ChangeSetView changeSet={changeSet} hasTask canCommit onCommit={onCommit} onLoadHunks={onLoadHunks} onOpenDiff={vi.fn()} onDiscard={vi.fn()} onRollback={vi.fn()} />);

    await userEvent.click(screen.getByRole("button", { name: "选择 src/user.ts 的任务差异块" }));
    expect(await screen.findByText("任务差异块 1")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("checkbox", { name: "任务差异块 1" }));
    await userEvent.click(screen.getByRole("button", { name: "提交选中 3 个文件" }));
    expect(onCommit).toHaveBeenCalledWith(["src/task.ts", "src/other.ts"], { "src/user.ts": ["hunk-1"] });
  });
});
