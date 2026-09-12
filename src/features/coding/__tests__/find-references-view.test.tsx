/**
 * Phase 2: FindReferencesView renders a flat hit list grouped by file and
 * jumps to (file, line) when the user clicks a row.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/tauri-api", () => ({
  codingApi: {
    refsFind: vi.fn(),
  },
}));

import { FindReferencesView } from "../main/FindReferencesView";
import { codingApi } from "../lib/tauri-api";
import type { ReferenceHit } from "../lib/types";

function makeHit(overrides: Partial<ReferenceHit> = {}): ReferenceHit {
  return {
    reference: {
      symbol: "authenticate",
      file: "src/api/auth.ts",
      line: 10,
      column: 1,
      kind: "call",
      preview: "authenticate(req)",
      ...(overrides.reference ?? {}),
    } as ReferenceHit["reference"],
    enclosingSymbol: overrides.enclosingSymbol ?? null,
  };
}

describe("FindReferencesView", () => {
  beforeEach(() => {
    vi.mocked(codingApi.refsFind).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("groups hits by file and renders each row", async () => {
    vi.mocked(codingApi.refsFind).mockResolvedValue([
      makeHit({ reference: { ...makeHit().reference, line: 12 } }),
      makeHit({ reference: { ...makeHit().reference, file: "src/server/index.ts", line: 5 } }),
    ]);

    render(<FindReferencesView root="/repo" symbol="authenticate" onOpenSymbol={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText("src/api/auth.ts")).toBeInTheDocument();
      expect(screen.getByText("src/server/index.ts")).toBeInTheDocument();
    });
    expect(screen.getAllByText("authenticate(req)").length).toBeGreaterThan(0);
    expect(screen.getByText(/2 处引用 · 2 个文件/)).toBeInTheDocument();
  });

  it("clicking a row calls onOpenSymbol with the file and line", async () => {
    vi.mocked(codingApi.refsFind).mockResolvedValue([
      makeHit(),
    ]);
    const onOpen = vi.fn();

    render(<FindReferencesView root="/repo" symbol="authenticate" onOpenSymbol={onOpen} />);

    await waitFor(() => screen.getByRole("button"));
    fireEvent.click(screen.getByRole("button"));

    expect(onOpen).toHaveBeenCalledWith({
      path: "src/api/auth.ts",
      line: 10,
      name: "authenticate",
    });
  });

  it("renders an empty state when no hits are found", async () => {
    vi.mocked(codingApi.refsFind).mockResolvedValue([]);
    render(<FindReferencesView root="/repo" symbol="missing" onOpenSymbol={() => {}} />);
    await waitFor(() =>
      expect(screen.getByText(/未找到 `missing` 的引用/)).toBeInTheDocument(),
    );
  });
});