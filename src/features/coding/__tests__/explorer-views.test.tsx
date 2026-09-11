import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ActivityBar } from "../shell/ActivityBar";
import { ChangeSetView } from "../explorer/ChangeSetView";
import { ContextPackView } from "../explorer/ContextPackView";
import { SymbolView } from "../explorer/SymbolView";
import type { ChangeSet, FileChange } from "../lib/types";

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
      ...overrides,
    };
    render(<ChangeSetView {...props} />);
    return props;
  }

  it("guides the user when no task exists", () => {
    setup({ hasTask: false });
    expect(screen.getByText(/新建开发任务后/)).toBeInTheDocument();
  });

  it("summarises line counts from task changes only", () => {
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
    // The protected file's 99 additions must not inflate the task's totals.
    const summary = container.querySelector(".coding-changeset__summary") as HTMLElement;
    expect(summary).toHaveTextContent("+10");
    expect(summary).not.toHaveTextContent("+109");
    expect(summary).toHaveTextContent("1 个文件");
  });

  it("lists pre-existing user changes separately as protected", () => {
    setup({
      changeSet: changeSet({
        changes: [change(), change({ path: "src/user.ts", preExisting: true })],
      }),
    });
    expect(screen.getByText(/任务开始前的改动 · 受保护/)).toBeInTheDocument();
  });

  it("offers no discard control for protected files", () => {
    setup({
      changeSet: changeSet({ changes: [change({ path: "src/user.ts", preExisting: true })] }),
    });
    expect(
      screen.queryByRole("button", { name: /丢弃 src\/user\.ts/ }),
    ).not.toBeInTheDocument();
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
  it("asks for an open file first", () => {
    render(<SymbolView symbols={[]} onOpenSymbol={vi.fn()} />);
    expect(screen.getByText(/打开一个文件后/)).toBeInTheDocument();
  });

  it("states the single-file limitation rather than implying full indexing", () => {
    render(<SymbolView symbols={[]} activeFileName="a.ts" onOpenSymbol={vi.fn()} />);
    expect(screen.getByText(/跨文件符号索引与引用查找将在后续版本接入/)).toBeInTheDocument();
  });

  it("jumps to a symbol", async () => {
    const user = userEvent.setup();
    const onOpenSymbol = vi.fn();
    render(
      <SymbolView
        symbols={[{ name: "handleLogin", path: "src/a.ts", line: 42 }]}
        activeFileName="a.ts"
        onOpenSymbol={onOpenSymbol}
      />,
    );
    await user.click(screen.getByRole("button", { name: /handleLogin/ }));
    expect(onOpenSymbol).toHaveBeenCalledWith(expect.objectContaining({ line: 42 }));
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
