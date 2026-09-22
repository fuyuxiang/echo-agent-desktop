import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listDir: vi.fn(async () => [] as unknown[]),
}));

vi.mock("@/lib/agent-client", () => ({
  listDir: mocks.listDir,
}));

import { FileTreeView } from "../FileTreeView";

describe("FileTreeView filter", () => {
  beforeEach(() => {
    mocks.listDir.mockReset();
    mocks.listDir.mockResolvedValue([]);
  });

  it("filters entries by case-insensitive substring", async () => {
    mocks.listDir.mockResolvedValue([
      { name: "README.md", path: "/r/README.md", kind: "file", size: 0, modifiedAt: 0, isLarge: false, isBinary: false },
      { name: "package.json", path: "/r/package.json", kind: "file", size: 0, modifiedAt: 0, isLarge: false, isBinary: false },
    ]);

    render(
      <FileTreeView
        rootPath="/r"
        onFileSelect={() => {}}
        filter="read"
      />,
    );

    expect(await screen.findByText("README.md")).not.toBeNull();
    expect(screen.queryByText("package.json")).toBeNull();
  });

  it("shows all entries when filter is empty", async () => {
    mocks.listDir.mockResolvedValue([
      { name: "a.ts", path: "/r/a.ts", kind: "file", size: 0, modifiedAt: 0, isLarge: false, isBinary: false },
      { name: "b.ts", path: "/r/b.ts", kind: "file", size: 0, modifiedAt: 0, isLarge: false, isBinary: false },
    ]);
    render(
      <FileTreeView rootPath="/r" onFileSelect={() => {}} />,
    );
    expect(await screen.findByText("a.ts")).not.toBeNull();
    expect(screen.getByText("b.ts")).not.toBeNull();
  });

  it("shows cwd-empty hint when root has no entries", async () => {
    mocks.listDir.mockResolvedValue([]);
    render(<FileTreeView rootPath="/empty" onFileSelect={() => {}} />);
    expect(await screen.findByText(/没有可见文件/)).not.toBeNull();
    expect(screen.getByRole("button", { name: "选择其他目录" })).not.toBeNull();
  });
});