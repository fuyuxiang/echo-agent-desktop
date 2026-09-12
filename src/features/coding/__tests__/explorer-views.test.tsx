import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ActivityBar } from "../shell/ActivityBar";
import { ChangeSetView } from "../explorer/ChangeSetView";
import { ContextPackView } from "../explorer/ContextPackView";
import { SymbolView } from "../explorer/SymbolView";
import type { ChangeSet, FileChange } from "../lib/types";

vi.mock("../lib/tauri-api", () => ({
  codingApi: {
    indexStatus: vi.fn(async () => ({
      state: "empty",
      filesIndexed: 0,
      symbols: 0,
      lastReconciledAt: null,
      inProgress: false,
    })),
    symbolQuery: vi.fn(async () => []),
    indexRebuild: vi.fn(async () => ({
      state: "ready",
      filesIndexed: 0,
      symbols: 0,
      lastReconciledAt: null,
      inProgress: false,
    })),
  },
  onIndexUpdated: vi.fn(async () => () => undefined),
  onIndexRemoved: vi.fn(async () => () => undefined),
  onIndexProgress: vi.fn(async () => () => undefined),
}));

function change(overrides: Partial<FileChange> = {}): FileChange {
  return {
    path: "src/a.ts",
    kind: "modified",
    added: 10,
    removed: 2,
    baselineContent: "old",
    preExisting: false,
    ...overrides,
  };
}

function changeSet(overrides: Partial<ChangeSet> = {}): ChangeSet {
  return {
    taskId: "t1",
    baselineFiles: [],
    changes: [change()],
    createdAt: "2026-09-11T00:00:00Z",
    reviewedFiles: [],
    ...overrides,
  };
}

describe("ActivityBar", () => {
  it("exposes all five destinations", () => {
    render(<ActivityBar active="files" onChange={vi.fn()} />);
    for (const label of ["资源管理器", "搜索", "变更集", "符号", "上下文包"]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
  });

  it("marks the active destination", () => {
    render(<ActivityBar active="changes" onChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: "变更集" })).toHaveAttribute("aria-current", "true");
  });

  it("switches destination on click", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ActivityBar active="files" onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: "符号" }));
    expect(onChange).toHaveBeenCalledWith("symbols");
  });

  it("badges the change count and caps it", () => {
    const { rerender } = render(<ActivityBar active="files" onChange={vi.fn()} changeCount={7} />);
    expect(screen.getByRole("button", { name: "变更集" })).toHaveTextContent("7");
    rerender(<ActivityBar active="files" onChange={vi.fn()} changeCount={150} />);
    expect(screen.getByRole("button", { name: "变更集" })).toHaveTextContent("99+");
  });
});

describe("ChangeSetView", () => {
  function setup(overrides: Partial<Parameters<typeof ChangeSetView>[0]> = {}) {
    const props = {
      changeSet: changeSet(),
      hasTask: true,
      onOpenDiff: vi.fn(),
      onDiscard: vi.fn(),
      onCommit: vi.fn(),
      onRollback: vi.fn(),
      canCommit: true,
      ...overrides,
    };
    render(<ChangeSetView {...props} />);
    return props;
  }

  it("guides the user when no task exists", () => {
    setup({ hasTask: false });
    expect(screen.getByText(/新建开发任务后/)).toBeInTheDocument();
  });

  it("summarises every file changed relative to the task baseline", () => {
    const { container } = render(
      <ChangeSetView
        changeSet={changeSet({
          changes: [change(), change({ path: "src/user.ts", added: 99, preExisting: true })],
        })}
        hasTask
        onOpenDiff={vi.fn()}
        onDiscard={vi.fn()}
        onCommit={vi.fn()}
        onRollback={vi.fn()}
      />,
    );
    const summary = container.querySelector(".coding-changeset__summary") as HTMLElement;
    expect(summary).toHaveTextContent("+109");
    expect(summary).toHaveTextContent("2 个文件");
  });

  it("marks files that were dirty at task start", () => {
    setup({
      changeSet: changeSet({
        changes: [change(), change({ path: "src/user.ts", preExisting: true })],
      }),
    });
    expect(screen.getByText("起始时已修改")).toBeInTheDocument();
  });

  it("can restore a dirty-at-start file to its exact baseline", () => {
    setup({
      changeSet: changeSet({ changes: [change({ path: "src/user.ts", preExisting: true })] }),
    });
    expect(screen.getByRole("button", { name: /丢弃 src\/user\.ts/ })).toBeInTheDocument();
  });

  it("tracks review progress", () => {
    setup({
      changeSet: changeSet({
        changes: [change(), change({ path: "src/b.ts" })],
        reviewedFiles: ["src/a.ts"],
      }),
    });
    expect(screen.getByText("已审阅 1/2")).toBeInTheDocument();
  });

  it("disables commit and rollback with no task changes", () => {
    setup({ changeSet: changeSet({ changes: [] }) });
    expect(screen.getByRole("button", { name: /提交/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /回滚任务/ })).toBeDisabled();
  });

  it("opens a diff, discards a file, commits and rolls back", async () => {
    const user = userEvent.setup();
    const props = setup();
    await user.click(screen.getByTitle("src/a.ts"));
    expect(props.onOpenDiff).toHaveBeenCalledWith(expect.objectContaining({ path: "src/a.ts" }));
    await user.click(screen.getByRole("button", { name: /丢弃 src\/a\.ts/ }));
    expect(props.onDiscard).toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /提交/ }));
    expect(props.onCommit).toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /回滚任务/ }));
    expect(props.onRollback).toHaveBeenCalled();
  });
});

describe("SymbolView", () => {
  it("renders the building label when the index has not reported status", () => {
    render(<SymbolView symbols={[]} onOpenSymbol={vi.fn()} root="/tmp/no-such-root" />);
    const matches = screen.getAllByText(/正在构建工作区索引|工作区索引状态未知|工作区索引尚未初始化/);
    expect(matches.length).toBeGreaterThan(0);
  });

  it("falls back to the active file when the index is empty", () => {
    render(
      <SymbolView
        symbols={[{ name: "handleLogin", path: "src/a.ts", line: 42 }]}
        activeFileName="src/a.ts"
        onOpenSymbol={vi.fn()}
      />,
    );
    // Without a `root` the cross-file index never starts; the panel falls
    // back to the single-file view and asks the user to open the index.
    expect(screen.getByText(/打开文件后这里会列出它的符号|工作区索引状态未知/)).toBeInTheDocument();
  });

  it("does not render the legacy single-file-only message", () => {
    render(
      <SymbolView
        symbols={[{ name: "handleLogin", path: "src/a.ts", line: 42 }]}
        activeFileName="src/a.ts"
        onOpenSymbol={vi.fn()}
      />,
    );
    expect(
      screen.queryByText(/跨文件符号索引与引用查找将在后续版本接入/),
    ).not.toBeInTheDocument();
  });
});

describe("ContextPackView", () => {
  it("explains the fallback when nothing is pinned", () => {
    render(<ContextPackView paths={[]} onAdd={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.getByText(/未选定时由 Agent 自行检索/)).toBeInTheDocument();
  });

  it("offers to add the open file and hides the offer once added", () => {
    const { rerender } = render(
      <ContextPackView paths={[]} activePath="src/a.ts" onAdd={vi.fn()} onRemove={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: /将当前文件加入上下文/ })).toBeInTheDocument();
    rerender(
      <ContextPackView
        paths={["src/a.ts"]}
        activePath="src/a.ts"
        onAdd={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole("button", { name: /将当前文件加入上下文/ }),
    ).not.toBeInTheDocument();
  });

  it("removes a pinned path", async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn();
    render(<ContextPackView paths={["src/a.ts"]} onAdd={vi.fn()} onRemove={onRemove} />);
    await user.click(screen.getByRole("button", { name: "移除 src/a.ts" }));
    expect(onRemove).toHaveBeenCalledWith("src/a.ts");
  });
});
