import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  initializeMonaco: vi.fn(),
  reportEvent: vi.fn(),
}));

vi.mock("../lib/monaco-bootstrap", () => ({
  initializeMonaco: mocks.initializeMonaco,
}));

vi.mock("@/lib/telemetry-contract", () => ({
  reportEvent: mocks.reportEvent,
}));

vi.mock("@/components/ThemeProvider", () => ({
  useTheme: () => ({ theme: "light" }),
}));

vi.mock("@monaco-editor/react", () => {
  const Editor = ({ value }: { value?: string }) => <div data-testid="monaco-editor">{value}</div>;
  const DiffEditor = ({ modified }: { modified?: string }) => (
    <div data-testid="monaco-diff-editor">{modified}</div>
  );
  return { default: Editor, Editor, DiffEditor };
});

import { CodingEditor } from "../main/CodingEditor";

function props() {
  return {
    path: "/repo/src/index.ts",
    language: "typescript",
    original: "const value = 1;",
    value: "const value = 1;",
    mode: "edit" as const,
    onChange: vi.fn(),
    onSave: vi.fn(),
  };
}

describe("CodingEditor startup", () => {
  beforeEach(() => {
    mocks.initializeMonaco.mockReset();
    mocks.reportEvent.mockReset();
  });

  it("shows a localized startup state and renders after local Monaco is ready", async () => {
    let resolve!: (value: unknown) => void;
    mocks.initializeMonaco.mockReturnValue(new Promise((done) => {
      resolve = done;
    }));

    render(<CodingEditor {...props()} />);
    expect(screen.getByRole("status")).toHaveTextContent("正在启动代码编辑器");
    expect(screen.queryByText("Loading...")).not.toBeInTheDocument();

    await act(async () => resolve({}));
    expect(screen.getByTestId("monaco-editor")).toHaveTextContent("const value = 1;");
  });

  it("turns initialization failures into an actionable error instead of an endless spinner", async () => {
    const error = new Error("worker failed");
    mocks.initializeMonaco.mockRejectedValue(error);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    render(<CodingEditor {...props()} />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("代码编辑器启动失败");
    expect(alert).toHaveTextContent("文件内容未被修改");
    expect(alert).toHaveTextContent("worker failed");
    expect(screen.getByRole("button", { name: "重新加载" })).toBeInTheDocument();
    expect(mocks.reportEvent).toHaveBeenCalledWith(
      "coding.editor.initialization_failed",
      "error",
      { detail: "worker failed" },
    );

    consoleError.mockRestore();
  });
});
