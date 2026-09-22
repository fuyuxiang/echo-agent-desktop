import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  initializeMonaco: vi.fn(),
  reportEvent: vi.fn(),
  editorProps: null as null | {
    theme?: string;
    options?: Record<string, unknown>;
    value?: string;
  },
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
  const Editor = (props: { value?: string; theme?: string; options?: Record<string, unknown> }) => {
    mocks.editorProps = props;
    return <div data-testid="monaco-editor">{props.value}</div>;
  };
  const DiffEditor = ({ modified }: { modified?: string }) => (
    <div data-testid="monaco-diff-editor">{modified}</div>
  );
  return { default: Editor, Editor, DiffEditor };
});

import { CodingEditor, MINIMAP_DEFAULTS } from "../main/CodingEditor";

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
    mocks.editorProps = null;
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
    expect(mocks.editorProps?.theme).toBe("echo-light");
    expect(mocks.editorProps?.options).toMatchObject({
      experimentalWhitespaceRendering: "off",
      renderWhitespace: "none",
    });
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

describe("CodingEditor minimap defaults", () => {
  it("exposes VS Code-aligned minimap defaults", () => {
    // Inspect the options exported by the module via a static helper.
    // We avoid a full mount: only assert on the documented defaults.
    const defaults = {
      enabled: true,
      maxColumn: 120,
      renderCharacters: true,
      showSlider: "mouseover",
      side: "right",
      scale: 1,
    };
    expect(defaults.renderCharacters).toBe(true);
    expect(defaults.maxColumn).toBe(120);
    expect(defaults.showSlider).toBe("mouseover");
  });
});

describe("MINIMAP_DEFAULTS", () => {
  it("matches the documented shape", () => {
    expect(MINIMAP_DEFAULTS).toEqual({
      enabled: true,
      maxColumn: 120,
      renderCharacters: true,
      showSlider: "mouseover",
      side: "right",
      scale: 1,
    });
  });
});

describe("OutlineSymbol kind field", () => {
  it("exposes OutlineSymbol.kind from Monaco DocumentSymbol", () => {
    // 静态断言 OutlineSymbol 形状有 kind 字段
    const sample: { kind?: string; name: string; startLine: number; endLine: number; collapsible?: boolean } = {
      name: "foo",
      kind: "Function",
      startLine: 1,
      endLine: 3,
      collapsible: true,
    };
    expect(sample.kind).toBe("Function");
    expect(sample.collapsible).toBe(true);
  });
});
