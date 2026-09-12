/**
 * Phase 2: GoToDefinitionView jumps directly when a single candidate is
 * found, and renders a list when multiple definitions exist.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/tauri-api", () => ({
  codingApi: {
    refsDefinition: vi.fn(),
  },
}));

import { GoToDefinitionView } from "../main/GoToDefinitionView";
import { codingApi } from "../lib/tauri-api";
import type { ReferenceHit } from "../lib/types";

function makeHit(overrides: Partial<ReferenceHit> = {}): ReferenceHit {
  return {
    reference: {
      symbol: "authenticate",
      file: "src/api/auth.ts",
      line: 10,
      column: 1,
      kind: "definition",
      preview: "export function authenticate(req) {}",
      ...(overrides.reference ?? {}),
    } as ReferenceHit["reference"],
    enclosingSymbol: null,
  };
}

describe("GoToDefinitionView", () => {
  beforeEach(() => {
    vi.mocked(codingApi.refsDefinition).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("jumps immediately and closes the tab when there is a single candidate", async () => {
    vi.mocked(codingApi.refsDefinition).mockResolvedValue([makeHit()]);
    const onJump = vi.fn();
    const onClose = vi.fn();

    render(
      <GoToDefinitionView
        root="/repo"
        symbol="authenticate"
        onJump={onJump}
        onOpenSymbol={() => {}}
        onClose={onClose}
      />,
    );

    await waitFor(() => {
      expect(onJump).toHaveBeenCalledWith({
        path: "src/api/auth.ts",
        line: 10,
        name: "authenticate",
      });
      expect(onClose).toHaveBeenCalled();
    });
  });

  it("renders a list of candidates when more than one definition exists", async () => {
    vi.mocked(codingApi.refsDefinition).mockResolvedValue([
      makeHit({ reference: { ...makeHit().reference, file: "src/a.ts", line: 10 } }),
      makeHit({ reference: { ...makeHit().reference, file: "src/b.ts", line: 22 } }),
    ]);
    const onOpen = vi.fn();
    const onClose = vi.fn();

    render(
      <GoToDefinitionView
        root="/repo"
        symbol="authenticate"
        onJump={() => {}}
        onOpenSymbol={onOpen}
        onClose={onClose}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/2 个候选定义/)).toBeInTheDocument();
    });
    const buttons = screen.getAllByRole("button");
    fireEvent.click(buttons[0]);

    expect(onOpen).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("renders an empty state when no definition is found", async () => {
    vi.mocked(codingApi.refsDefinition).mockResolvedValue([]);
    render(
      <GoToDefinitionView
        root="/repo"
        symbol="missing"
        onJump={() => {}}
        onOpenSymbol={() => {}}
        onClose={() => {}}
      />,
    );
    await waitFor(() =>
      expect(screen.getByText(/未找到 `missing` 的定义/)).toBeInTheDocument(),
    );
  });
});