import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TheiaTaskReview } from "../TheiaTaskReview";

const invoke = vi.fn(async (command: string, _args?: unknown): Promise<unknown> => {
  if (command === "coding_changeset_diff") {
    return { original: "binary", modified: "binary", binary: true, modifiedHash: "content-v1" };
  }
  return null;
});

vi.mock("@tauri-apps/api/core", () => ({ invoke: (command: string, args: unknown) => invoke(command, args) }));
vi.mock("@monaco-editor/react", () => ({ DiffEditor: () => <div>文本差异</div> }));

describe("Theia task review", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockImplementation(async (command: string): Promise<unknown> => {
      if (command === "coding_changeset_diff") {
        return { original: "binary", modified: "binary", binary: true, modifiedHash: "content-v1" };
      }
      return null;
    });
  });

  it("requires explicit binary review and binds approval to the displayed content version", async () => {
    const onReviewed = vi.fn(async () => undefined);
    render(<TheiaTaskReview root="/repo" taskId="task-1" path="asset.png" onClose={vi.fn()} onOpenFile={vi.fn()} onReviewed={onReviewed} />);
    const button = await screen.findByRole("button", { name: "标记已审阅" });
    expect(button).toBeDisabled();
    await userEvent.click(screen.getByRole("checkbox", { name: "我已核对当前版本的二进制文件" }));
    expect(button).toBeEnabled();
    await userEvent.click(button);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("coding_changeset_mark_reviewed", {
      root: "/repo", taskId: "task-1", path: "asset.png", expectedHash: "content-v1",
    }));
    expect(onReviewed).toHaveBeenCalledOnce();
  });
});
