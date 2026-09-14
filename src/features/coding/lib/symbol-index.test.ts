import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  IndexRemovedEvent,
  IndexStatus,
  IndexUpdatedEvent,
  SymbolQueryHit,
  SymbolRecord,
} from "./types";
import { getSymbolIndexClient, resetSymbolIndexClients } from "./symbol-index";

const statusListeners = new Set<(event: IndexUpdatedEvent) => void>();
const removedListeners = new Set<(event: IndexRemovedEvent) => void>();

const sampleSymbol = (overrides: Partial<SymbolRecord> = {}): SymbolRecord => ({
  id: overrides.id ?? "id-1",
  name: overrides.name ?? "authenticate",
  kind: overrides.kind ?? "function",
  container: overrides.container ?? null,
  file: overrides.file ?? "src/a.ts",
  line: overrides.line ?? 1,
  column: overrides.column ?? 1,
  signature: overrides.signature ?? null,
  exported: overrides.exported ?? true,
});

const sampleStatus = (overrides: Partial<IndexStatus> = {}): IndexStatus => ({
  state: overrides.state ?? "ready",
  filesIndexed: overrides.filesIndexed ?? 3,
  symbols: overrides.symbols ?? 12,
  lastReconciledAt: overrides.lastReconciledAt ?? "2026-09-12T00:00:00Z",
  inProgress: overrides.inProgress ?? false,
});

const invokeMock = vi.fn(async (cmd: string, args: Record<string, unknown>) => {
  if (cmd === "coding_index_status") {
    return sampleStatus();
  }
  if (cmd === "coding_symbol_query") {
    const needle = String(args.needle ?? "");
    const all: SymbolRecord[] = [
      sampleSymbol({ id: "id-a", name: "authenticate", file: "src/auth.ts", line: 12 }),
      sampleSymbol({ id: "id-b", name: "authorize", file: "src/auth.ts", line: 22 }),
      sampleSymbol({ id: "id-c", name: "validateToken", file: "src/token.ts", line: 5 }),
    ];
    const filtered = needle ? all.filter((s) => s.name.includes(needle)) : all;
    const hits: SymbolQueryHit[] = filtered.map((symbol, index) => ({
      symbol,
      score: 100 - index,
    }));
    return hits;
  }
  throw new Error(`unexpected command: ${cmd}`);
});

vi.mock("./tauri-api", () => ({
  codingApi: {
    indexStatus: (root: string) => invokeMock("coding_index_status", { root }),
    symbolQuery: (
      root: string,
      needle: string,
      kind?: string,
      limit?: number,
      offset?: number,
    ) => invokeMock("coding_symbol_query", { root, needle, kind, limit, offset }),
    indexRebuild: vi.fn(async () => sampleStatus({ state: "ready" })),
  },
  onIndexUpdated: vi.fn((cb: (event: IndexUpdatedEvent) => void) => {
    // Defer registration so the SymbolIndexClient's teardown path can
    // intercept the cancel callback before the listener is actually added.
    return new Promise<() => void>((resolveCancel) => {
      setTimeout(() => {
        statusListeners.add(cb);
        resolveCancel(() => statusListeners.delete(cb));
      }, 0);
    });
  }),
  onIndexRemoved: vi.fn((cb: (event: IndexRemovedEvent) => void) => {
    return new Promise<() => void>((resolveCancel) => {
      setTimeout(() => {
        removedListeners.add(cb);
        resolveCancel(() => removedListeners.delete(cb));
      }, 0);
    });
  }),
}));

beforeEach(() => {
  invokeMock.mockClear();
  statusListeners.clear();
  removedListeners.clear();
  resetSymbolIndexClients();
});

afterEach(() => {
  resetSymbolIndexClients();
});

describe("SymbolIndexClient", () => {
  it("returns the same instance for the same root", () => {
    const a = getSymbolIndexClient("/workspace/a");
    const b = getSymbolIndexClient("/workspace/a");
    expect(a).toBe(b);
    const c = getSymbolIndexClient("/workspace/b");
    expect(c).not.toBe(a);
  });

  it("search ranks prefix and exact matches higher than substring", async () => {
    const client = getSymbolIndexClient("/workspace/rank");
    await refresh(client);
    const hits = client.search("auth");
    expect(hits.map((h) => h.symbol.name)).toEqual(["authenticate", "authorize"]);
    // Strict prefix outranks the substring fallback.
    expect(hits[0].symbol.name).toBe("authenticate");
    const exact = client.search("validateToken");
    expect(exact[0].symbol.name).toBe("validateToken");
    expect(exact[0].score).toBeGreaterThanOrEqual(hits[0].score);
  });

  it("filters by SymbolKind", async () => {
    const client = getSymbolIndexClient("/workspace/kind");
    await refresh(client);
    const classHits = client.search("auth", "class");
    expect(classHits).toEqual([]);
  });

  it("symbolAt returns the innermost symbol on the requested line", async () => {
    const client = getSymbolIndexClient("/workspace/at");
    await refresh(client);
    const symbol = client.symbolAt("src/auth.ts", 15);
    expect(symbol?.name).toBe("authenticate");
    expect(symbol?.file).toBe("src/auth.ts");
  });

  it("subscribe triggers refresh and re-fires on index-updated", async () => {
    const client = getSymbolIndexClient("/workspace/sub");
    const listener = vi.fn();
    client.subscribe(listener);
    // First call comes from the initial bootstrap; allow the microtasks
    // produced by onIndexUpdated.then to resolve.
    await flush();
    expect(listener).toHaveBeenCalled();
    const before = listener.mock.calls.length;
    statusListeners.forEach((cb) =>
      cb({ root: "/workspace/sub", file: "src/auth.ts", added: 1, updated: 1, removed: 0 }),
    );
    await flush();
    expect(listener.mock.calls.length).toBeGreaterThan(before);
  });

  it("subscribe removes entries on index-removed", async () => {
    const client = getSymbolIndexClient("/workspace/rm");
    const listener = vi.fn();
    const unsubscribe = client.subscribe(listener);
    await flush();
    expect(client.symbolAt("src/auth.ts", 12)?.name).toBe("authenticate");
    removedListeners.forEach((cb) =>
      cb({ root: "/workspace/rm", file: "src/auth.ts" }),
    );
    await flush();
    expect(client.symbolAt("src/auth.ts", 12)).toBeUndefined();
    unsubscribe();
  });

  it("dispose releases listeners", async () => {
    const client = getSymbolIndexClient("/workspace/dispose");
    const listener = vi.fn();
    const unsubscribe = client.subscribe(listener);
    unsubscribe();
    expect(statusListeners.size).toBe(0);
    expect(removedListeners.size).toBe(0);
  });

  it("loads indexes larger than one backend page without truncation", async () => {
    const firstPage = Array.from({ length: 2_000 }, (_, index) => ({
      symbol: sampleSymbol({ id: `id-${index}`, name: `symbol${index}`, line: index + 1 }),
      score: 1,
    }));
    const last = {
      symbol: sampleSymbol({ id: "id-2000", name: "lastSymbol", line: 2_001 }),
      score: 1,
    };
    invokeMock
      .mockResolvedValueOnce(sampleStatus({ symbols: 2_001 }))
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce([last]);
    const client = getSymbolIndexClient("/workspace/large");

    await client.refresh();

    const queryCalls = invokeMock.mock.calls.filter(([command]) => command === "coding_symbol_query");
    expect(queryCalls.map(([, args]) => args.offset)).toEqual([0, 2_000]);
    expect(client.symbolAt("src/a.ts", 2_001)?.name).toBe("lastSymbol");
  });

  it("keeps a new subscriber when teardown races asynchronous subscription", async () => {
    const client = getSymbolIndexClient("/workspace/resubscribe");
    const first = client.subscribe(vi.fn());
    first();
    const secondListener = vi.fn();
    const second = client.subscribe(secondListener);

    await flush();
    expect(statusListeners.size).toBe(1);
    expect(removedListeners.size).toBe(1);
    const before = secondListener.mock.calls.length;
    statusListeners.forEach((listener) => listener({
      root: "/workspace/resubscribe",
      file: "src/a.ts",
      added: 0,
      updated: 1,
      removed: 0,
    }));
    await flush();
    expect(secondListener.mock.calls.length).toBeGreaterThan(before);
    second();
  });
});

async function refresh(client: ReturnType<typeof getSymbolIndexClient>): Promise<void> {
  await client.refresh();
  await flush();
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
