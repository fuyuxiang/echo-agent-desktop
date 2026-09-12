/**
 * Phase 2: ImpactAnalysisView renders the three layers (direct / transitive /
 * testImpact) and the raw edges list, jumping to a symbol on click.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/tauri-api", () => ({
  codingApi: {
    impactAnalyze: vi.fn(),
  },
}));

import { ImpactAnalysisView } from "../main/ImpactAnalysisView";
import { codingApi } from "../lib/tauri-api";
import type { ImpactGraph, ImpactNode, SymbolRecord } from "../lib/types";

function symbolRecord(overrides: Partial<SymbolRecord> = {}): SymbolRecord {
  return {
    id: "sym-1",
    name: "authenticate",
    kind: "function",
    container: null,
    file: "src/api/auth.ts",
    line: 10,
    column: 1,
    signature: "function authenticate(req: Request)",
    exported: true,
    ...overrides,
  };
}

function impactNode(overrides: Partial<ImpactNode> = {}): ImpactNode {
  return {
    symbol: symbolRecord(overrides.symbol as Partial<SymbolRecord> ?? {}),
    references: 3,
    tests: 1,
    depth: 1,
    ...overrides,
  };
}

function makeGraph(): ImpactGraph {
  return {
    target: "authenticate",
    direct: [
      impactNode({
        symbol: symbolRecord({ id: "b", name: "run", file: "src/server/run.ts", line: 12 }),
        references: 1,
        tests: 0,
      }),
    ],
    transitive: [
      impactNode({
        symbol: symbolRecord({
          id: "c",
          name: "testRun",
          file: "tests/run.test.ts",
          line: 22,
        }),
        references: 1,
        tests: 1,
        depth: 2,
      }),
    ],
    testImpact: [
      symbolRecord({ id: "c", name: "testRun", file: "tests/run.test.ts", line: 22 }),
    ],
    edges: [
      {
        fromFile: "src/server/run.ts",
        fromLine: 12,
        to: "authenticate",
        kind: "call",
      },
    ],
    depthUsed: 2,
  };
}

describe("ImpactAnalysisView", () => {
  beforeEach(() => {
    vi.mocked(codingApi.impactAnalyze).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders three layers for a two-level impact graph", async () => {
    vi.mocked(codingApi.impactAnalyze).mockResolvedValue(makeGraph());

    render(<ImpactAnalysisView root="/repo" symbol="authenticate" onOpenSymbol={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText("受影响测试")).toBeInTheDocument();
    });
    expect(screen.getAllByText((_, node) => (node?.textContent ?? "").startsWith("直接调用方")).length).toBeGreaterThan(0);
    expect(screen.getAllByText((_, node) => (node?.textContent ?? "").startsWith("传递调用方")).length).toBeGreaterThan(0);
    expect(screen.getByText("run")).toBeInTheDocument();
    expect(screen.getAllByText("testRun").length).toBeGreaterThan(0);
    expect(screen.getByText("深度 2 · 1 直接 · 1 传递")).toBeInTheDocument();
  });

  it("clicking a caller row opens the file at the symbol line", async () => {
    vi.mocked(codingApi.impactAnalyze).mockResolvedValue(makeGraph());
    const onOpen = vi.fn();

    render(<ImpactAnalysisView root="/repo" symbol="authenticate" onOpenSymbol={onOpen} />);

    await waitFor(() => screen.getAllByRole("button")[0]);
    const buttons = screen.getAllByRole("button");
    fireEvent.click(buttons[0]);

    expect(onOpen).toHaveBeenCalledWith({
      path: "src/server/run.ts",
      line: 12,
      name: "run",
    });
  });

  it("renders only the header when the target has no impact", async () => {
    vi.mocked(codingApi.impactAnalyze).mockResolvedValue({
      target: "noop",
      direct: [],
      transitive: [],
      testImpact: [],
      edges: [],
      depthUsed: 2,
    });
    render(<ImpactAnalysisView root="/repo" symbol="noop" onOpenSymbol={() => {}} />);
    await waitFor(() =>
      expect(screen.getByText("深度 2 · 0 直接 · 0 传递")).toBeInTheDocument(),
    );
  });
});