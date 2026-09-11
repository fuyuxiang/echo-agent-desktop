import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const monacoMock = vi.hoisted(() => ({
  mounted: false,
  saveCommand: undefined as (() => void) | undefined,
}));

vi.mock("@monaco-editor/react", () => {
  const model = { uri: { toString: () => "file:///repo/src/app.ts" } };
  const editor = {
    addCommand: (_key: number, command: () => void) => {
      monacoMock.saveCommand = command;
    },
    focus: vi.fn(),
    getModel: () => model,
    setPosition: vi.fn(),
    revealPositionInCenter: vi.fn(),
  };
  const monaco = {
    KeyMod: { CtrlCmd: 1 },
    KeyCode: { KeyS: 2 },
    MarkerSeverity: { Error: 8, Warning: 4 },
    editor: {
      getModelMarkers: () => [],
      onDidChangeMarkers: () => ({ dispose: vi.fn() }),
    },
  };
  return {
    default: (props: { onMount?: (instance: typeof editor, api: typeof monaco) => void }) => {
      if (!monacoMock.mounted) {
        monacoMock.mounted = true;
        props.onMount?.(editor, monaco);
      }
      return <div data-testid="mock-monaco" />;
    },
    DiffEditor: () => <div data-testid="mock-monaco-diff" />,
  };
});

import { CodingEditor } from "../coding-workspace/CodingEditor";

describe("CodingEditor", () => {
  beforeEach(() => {
    monacoMock.mounted = false;
    monacoMock.saveCommand = undefined;
  });

  it("Cmd/Ctrl+S 始终调用最新的保存回调，不使用首次渲染的旧文件状态", () => {
    const firstSave = vi.fn();
    const latestSave = vi.fn();
    const props = {
      path: "/repo/src/app.ts",
      language: "typescript",
      original: "export const answer = 41;",
      value: "export const answer = 42;",
      mode: "edit" as const,
      onChange: vi.fn(),
    };
    const view = render(<CodingEditor {...props} onSave={firstSave} />);
    view.rerender(<CodingEditor {...props} onSave={latestSave} />);

    act(() => monacoMock.saveCommand?.());

    expect(latestSave).toHaveBeenCalledTimes(1);
    expect(firstSave).not.toHaveBeenCalled();
  });
});
