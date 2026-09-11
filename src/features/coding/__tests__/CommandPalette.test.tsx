import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { CommandPalette, type PaletteMode } from "../shell/CommandPalette";
import type { WorkbenchCommand } from "../lib/commands";

function commands(overrides: Partial<WorkbenchCommand>[] = []): WorkbenchCommand[] {
  const base: WorkbenchCommand[] = [
    { id: "a", title: "运行全部验证", group: "verify", keywords: ["test"], run: vi.fn() },
    { id: "b", title: "提交本次任务的变更", group: "review", keywords: ["commit"], run: vi.fn() },
    { id: "c", title: "回滚本次任务的全部改动", group: "task", enabled: false, run: vi.fn() },
  ];
  return base.map((command, index) => ({ ...command, ...(overrides[index] ?? {}) }));
}

function setup(mode: PaletteMode = "commands", extra: Partial<Parameters<typeof CommandPalette>[0]> = {}) {
  const props = {
    mode,
    commands: commands(),
    paths: ["src/auth/login.ts", "src/components/Button.tsx"],
    symbols: [{ name: "handleLogin", path: "src/auth/login.ts", line: 42, detail: "function" }],
    onClose: vi.fn(),
    onOpenPath: vi.fn(),
    onOpenSymbol: vi.fn(),
    onModeChange: vi.fn(),
    ...extra,
  };
  render(<CommandPalette {...props} />);
  return props;
}

describe("CommandPalette", () => {
  it("lists commands grouped by capability", () => {
    setup();
    expect(screen.getByText("验证")).toBeInTheDocument();
    expect(screen.getByText("变更审阅")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /运行全部验证/ })).toBeInTheDocument();
  });

  it("filters as the user types", async () => {
    const user = userEvent.setup();
    setup();
    await user.type(screen.getByRole("combobox"), "提交");
    expect(screen.getByRole("option", { name: /提交本次任务的变更/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /运行全部验证/ })).not.toBeInTheDocument();
  });

  it("runs the highlighted command on Enter and closes", async () => {
    const user = userEvent.setup();
    const props = setup();
    await user.type(screen.getByRole("combobox"), "commit");
    await user.keyboard("{Enter}");
    expect(props.commands[1].run).toHaveBeenCalledOnce();
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it("refuses to run a disabled command", async () => {
    const user = userEvent.setup();
    const props = setup();
    await user.type(screen.getByRole("combobox"), "回滚");
    await user.keyboard("{Enter}");
    expect(props.commands[2].run).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("moves the selection with arrow keys", async () => {
    const user = userEvent.setup();
    const props = setup();
    await user.keyboard("{ArrowDown}{Enter}");
    // Second command in the unfiltered list.
    expect(props.commands[1].run).toHaveBeenCalledOnce();
  });

  it("closes on Escape", async () => {
    const user = userEvent.setup();
    const props = setup();
    await user.keyboard("{Escape}");
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it("switches to command search when the query starts with >", async () => {
    const user = userEvent.setup();
    setup("files");
    await user.type(screen.getByRole("combobox"), ">提交");
    expect(screen.getByRole("option", { name: /提交本次任务的变更/ })).toBeInTheDocument();
  });

  it("opens a file from quick-open mode", async () => {
    const user = userEvent.setup();
    const props = setup("files");
    await user.type(screen.getByRole("combobox"), "login");
    await user.keyboard("{Enter}");
    expect(props.onOpenPath).toHaveBeenCalledWith("src/auth/login.ts");
  });

  it("shows an indexing hint while paths are still loading", () => {
    setup("files", { paths: [], pathsLoading: true });
    expect(screen.getByText(/正在建立文件索引/)).toBeInTheDocument();
  });

  it("opens a symbol with its location", async () => {
    const user = userEvent.setup();
    const props = setup("symbols");
    await user.keyboard("{Enter}");
    expect(props.onOpenSymbol).toHaveBeenCalledWith(
      expect.objectContaining({ name: "handleLogin", line: 42 }),
    );
  });

  it("reports when nothing matches", async () => {
    const user = userEvent.setup();
    setup();
    await user.type(screen.getByRole("combobox"), "zzzqqq");
    expect(screen.getByText("没有匹配项")).toBeInTheDocument();
  });
});
