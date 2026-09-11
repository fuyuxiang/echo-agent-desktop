import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

vi.mock("../panels/CodingTerminal", () => ({
  CodingTerminal: () => <div data-testid="terminal" />,
}));

import { BottomPanel } from "../panels/BottomPanel";
import { ProblemsView } from "../panels/ProblemsView";
import { VerificationView } from "../panels/VerificationView";
import type { Problem, VerificationRecord } from "../lib/types";

function problem(overrides: Partial<Problem> = {}): Problem {
  return {
    id: "p1",
    kind: "type",
    severity: "error",
    message: "Argument of type string is not assignable",
    file: "src/auth.ts",
    line: 42,
    column: 17,
    sourceCommand: "pnpm typecheck",
    fingerprint: "abc",
    ...overrides,
  };
}

function record(overrides: Partial<VerificationRecord> = {}): VerificationRecord {
  return {
    id: "v1",
    taskId: "t1",
    kind: "test",
    command: "pnpm test",
    status: "passed",
    exitCode: 0,
    stdout: "",
    stderr: "",
    durationMs: 1_500,
    startedAt: "",
    finishedAt: "",
    testSummary: { total: 42, passed: 42, failed: 0, skipped: 0 },
    structured: true,
    ...overrides,
  };
}

describe("ProblemsView", () => {
  it("reports a clean state", () => {
    render(<ProblemsView problems={[]} onOpenProblem={vi.fn()} />);
    expect(screen.getByText("当前没有检测到问题")).toBeInTheDocument();
  });

  it("counts errors and warnings separately", () => {
    render(
      <ProblemsView
        problems={[problem(), problem({ id: "p2", severity: "warning" })]}
        onOpenProblem={vi.fn()}
      />,
    );
    expect(screen.getByText("1 个错误")).toBeInTheDocument();
    expect(screen.getByText("1 个警告")).toBeInTheDocument();
  });

  it("shows the backend's classification rather than a generic label", () => {
    render(
      <ProblemsView
        problems={[problem({ kind: "dependency", message: "npm ERR! 404" })]}
        onOpenProblem={vi.fn()}
      />,
    );
    expect(screen.getByText("依赖")).toBeInTheDocument();
  });

  it("jumps to a problem's location", async () => {
    const user = userEvent.setup();
    const onOpenProblem = vi.fn();
    render(<ProblemsView problems={[problem()]} onOpenProblem={onOpenProblem} />);
    await user.click(screen.getByRole("button"));
    expect(onOpenProblem).toHaveBeenCalledWith(expect.objectContaining({ line: 42 }));
  });

  it("does not offer navigation for a problem with no file", () => {
    render(
      <ProblemsView problems={[problem({ file: null, line: null })]} onOpenProblem={vi.fn()} />,
    );
    expect(screen.getByRole("button")).toBeDisabled();
  });

  it("shows the failing test name when the parser found one", () => {
    render(
      <ProblemsView
        problems={[problem({ kind: "test_failure", symbol: "test_login_rejects_expired" })]}
        onOpenProblem={vi.fn()}
      />,
    );
    expect(screen.getByText("test_login_rejects_expired")).toBeInTheDocument();
  });
});

describe("VerificationView", () => {
  function setup(overrides: Partial<Parameters<typeof VerificationView>[0]> = {}) {
    const props = {
      records: [],
      detected: [{ kind: "test" as const, command: "pnpm test", label: "测试" }],
      running: false,
      hasTask: true,
      onRun: vi.fn(),
      onRunAll: vi.fn(),
      onOpenOutput: vi.fn(),
      ...overrides,
    };
    render(<VerificationView {...props} />);
    return props;
  }

  it("runs all detected commands", async () => {
    const user = userEvent.setup();
    const props = setup();
    await user.click(screen.getByRole("button", { name: /运行全部验证/ }));
    expect(props.onRunAll).toHaveBeenCalled();
  });

  it("runs a single detected command", async () => {
    const user = userEvent.setup();
    const props = setup();
    await user.click(screen.getByRole("button", { name: "测试" }));
    expect(props.onRun).toHaveBeenCalledWith(
      expect.objectContaining({ command: "pnpm test" }),
    );
  });

  it("states when no verification command was detected", () => {
    setup({ detected: [] });
    expect(screen.getByText(/未从工程清单识别到验证命令/)).toBeInTheDocument();
  });

  it("disables running without a task", () => {
    setup({ hasTask: false });
    expect(screen.getByRole("button", { name: /运行全部验证/ })).toBeDisabled();
  });

  it("shows the parsed test summary", () => {
    setup({ records: [record()] });
    expect(screen.getByText("42 通过 / 0 失败")).toBeInTheDocument();
  });

  it("flags a record whose output could not be parsed", () => {
    setup({ records: [record({ structured: false, testSummary: null })] });
    expect(screen.getByTitle(/仅依据退出码/)).toBeInTheDocument();
  });

  it("distinguishes timeout and cancellation from failure", () => {
    setup({
      records: [
        record({ id: "a", status: "timed_out", exitCode: null, testSummary: null }),
        record({ id: "b", status: "cancelled", exitCode: null, testSummary: null }),
        record({ id: "c", status: "failed", exitCode: 1, testSummary: null }),
      ],
    });
    expect(screen.getByText("超时")).toBeInTheDocument();
    expect(screen.getByText("已取消")).toBeInTheDocument();
    expect(screen.getByText("失败")).toBeInTheDocument();
  });

  it("always shows the exit code the verdict came from", () => {
    setup({ records: [record({ status: "failed", exitCode: 1, testSummary: null })] });
    expect(screen.getByText(/退出码 1/)).toBeInTheDocument();
  });
});

describe("BottomPanel", () => {
  function setup(overrides: Partial<Parameters<typeof BottomPanel>[0]> = {}) {
    const props = {
      root: "/repo",
      view: "problems" as const,
      onViewChange: vi.fn(),
      onCollapse: vi.fn(),
      onResize: vi.fn(),
      height: 220,
      problems: [problem()],
      records: [record()],
      detected: [],
      running: false,
      hasTask: true,
      output: "",
      messages: [],
      terminalActivated: false,
      onActivateTerminal: vi.fn(),
      onOpenProblem: vi.fn(),
      onRun: vi.fn(),
      onRunAll: vi.fn(),
      ...overrides,
    };
    render(<BottomPanel {...props} />);
    return props;
  }

  it("badges the problem and record counts", () => {
    setup();
    const tabs = screen.getByRole("tablist", { name: "开发工具面板" });
    expect(tabs).toHaveTextContent("问题");
    expect(tabs).toHaveTextContent("1");
  });

  it("switches tabs", async () => {
    const user = userEvent.setup();
    const props = setup();
    await user.click(screen.getByRole("tab", { name: /验证/ }));
    expect(props.onViewChange).toHaveBeenCalledWith("tests");
  });

  it("activates the terminal before showing its tab", async () => {
    const user = userEvent.setup();
    const props = setup();
    await user.click(screen.getByRole("tab", { name: "终端" }));
    expect(props.onActivateTerminal).toHaveBeenCalled();
    expect(props.onViewChange).toHaveBeenCalledWith("terminal");
  });

  it("keeps the terminal mounted while another tab is shown", () => {
    setup({ terminalActivated: true, view: "problems" });
    // Present but hidden, so the PTY is not torn down on a tab switch.
    expect(screen.getByTestId("terminal")).toBeInTheDocument();
  });

  it("collapses on request", async () => {
    const user = userEvent.setup();
    const props = setup();
    await user.click(screen.getByRole("button", { name: "收起面板" }));
    expect(props.onCollapse).toHaveBeenCalled();
  });

  it("shows a placeholder before any command output", () => {
    setup({ view: "output" });
    expect(screen.getByText("尚无命令输出。")).toBeInTheDocument();
  });

  it("resizes with the keyboard", async () => {
    const user = userEvent.setup();
    const props = setup();
    const separator = screen.getByRole("separator", { name: "调整开发工具面板高度" });
    separator.focus();
    await user.keyboard("{ArrowUp}");
    expect(props.onResize).toHaveBeenCalledWith(236);
  });

  it("reports an empty trace", () => {
    setup({ view: "trace" });
    expect(screen.getByText("Agent 尚未调用工具")).toBeInTheDocument();
  });
});
