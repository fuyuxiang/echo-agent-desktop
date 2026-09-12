/**
 * Front-end mirror of the cross-file symbol index (phase 2).
 *
 * `SymbolIndexClient` is a singleton per workspace root. It maintains an
 * in-memory `Map<file, SymbolRecord[]>` that mirrors the on-disk JSONL
 * index and exposes search / lookup helpers. Mutations come from
 * `coding://index-updated` / `coding://index-removed` events; consumers
 * subscribe via `subscribe` and re-render on change.
 *
 * The full list is rebuilt via `coding_symbol_query` on demand; file-level
 * diffs are inferred from event payloads to avoid refetching the entire
 * workspace after every save. The on-disk index is authoritative — when
 * the snapshot diverges (e.g. the file was edited while the listener was
 * offline), call `refresh()` to re-pull.
 */

import { codingApi, onIndexRemoved, onIndexUpdated } from "./tauri-api";
import type { IndexStatus, SymbolKind, SymbolQueryHit, SymbolRecord } from "./types";

export type IndexSnapshot = {
  status: IndexStatus;
  symbols: SymbolRecord[];
};

type Listener = () => void;

const clients = new Map<string, SymbolIndexClient>();

export function getSymbolIndexClient(root: string): SymbolIndexClient {
  const existing = clients.get(root);
  if (existing) return existing;
  const created = new SymbolIndexClient(root);
  clients.set(root, created);
  return created;
}

export function resetSymbolIndexClients(): void {
  for (const client of clients.values()) {
    client.dispose();
  }
  clients.clear();
}

export class SymbolIndexClient {
  private readonly root: string;
  private readonly byFile = new Map<string, SymbolRecord[]>();
  private all: SymbolRecord[] = [];
  private status: IndexStatus = {
    state: "empty",
    filesIndexed: 0,
    symbols: 0,
    lastReconciledAt: null,
    inProgress: false,
  };
  private listeners = new Set<Listener>();
  private subscribed = false;

  constructor(root: string) {
    this.root = root;
  }

  status_snapshot(): IndexStatus {
    return this.status;
  }

  symbols(): SymbolRecord[] {
    return this.all;
  }

  /** Filter & rank symbols with the same heuristic the backend uses. */
  search(query: string, kind?: SymbolKind, limit = 50): SymbolQueryHit[] {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    const hits: SymbolQueryHit[] = [];
    for (const symbol of this.all) {
      if (kind && symbol.kind !== kind) continue;
      const score = scoreSymbol(symbol, needle);
      if (score <= 0) continue;
      hits.push({ symbol, score });
    }
    hits.sort(
      (a, b) =>
        b.score - a.score || a.symbol.name.localeCompare(b.symbol.name) || a.symbol.line - b.symbol.line,
    );
    return hits.slice(0, limit);
  }

  symbolAt(file: string, line: number): SymbolRecord | undefined {
    let best: SymbolRecord | undefined;
    for (const symbol of this.byFile.get(file) ?? []) {
      if (symbol.line > line) continue;
      if (!best || symbol.line > best.line) best = symbol;
    }
    return best;
  }

  private bootstrapping: Promise<void> | null = null;
  private bootstrapStarted = false;
  // Tracks event subscription lifecycle so teardown can synchronously
  // cancel even when the underlying `onIndexUpdated` / `onIndexRemoved`
  // Tauri calls return promises.
  private teardownRequested = false;
  private pendingCancels: Array<() => void> = [];

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    if (!this.subscribed && !this.bootstrapStarted) {
      this.bootstrapStarted = true;
      this.subscribed = true;
      this.bootstrapping = this.bootstrap();
      this.bootstrapping.finally(() => {
        this.bootstrapping = null;
      });
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        this.teardown();
      }
    };
  }  /** Pull the latest status and replace the in-memory list. */
  async refresh(): Promise<void> {
    try {
      this.status = await codingApi.indexStatus(this.root);
      if (this.status.state === "ready" || this.status.state === "stale") {
        const hits = await codingApi.symbolQuery(this.root, "", undefined, 5000);
        this.replaceAll(hits.map((hit) => hit.symbol));
      }
    } catch (error) {
      // Network or backend failure: leave the cache alone so a stale UI
      // is preferable to a blank one. Callers can rebuild explicitly.
      console.warn("[symbol-index] refresh failed", error);
    } finally {
      this.notify();
    }
  }

  /** Force a backend rebuild, then refresh. */
  async rebuild(): Promise<void> {
    this.status = { ...this.status, state: "rebuilding", inProgress: true };
    this.notify();
    try {
      this.status = await codingApi.indexRebuild(this.root);
      const hits = await codingApi.symbolQuery(this.root, "", undefined, 5000);
      this.replaceAll(hits.map((hit) => hit.symbol));
    } finally {
      this.notify();
    }
  }

  /** Stop watching the workspace and release the event subscriptions. */
  teardown(): void {
    if (this.bootstrapping) {
      this.teardownRequested = true;
      this.bootstrapping.then(() => this.runUnlisten());
    } else {
      this.runUnlisten();
    }
  }

  private runUnlisten(): void {
    for (const cancel of this.pendingCancels) cancel();
    this.pendingCancels = [];
    this.subscribed = false;
  }

  dispose(): void {
    this.teardown();
  }

  private async bootstrap(): Promise<void> {
    try {
      const cancelUpdated = await onIndexUpdated((event) => {
        if (event.root !== this.root) return;
        void this.handleFileUpdated(event.file);
      });
      if (this.teardownRequested) {
        cancelUpdated();
        return;
      }
      this.pendingCancels.push(cancelUpdated);
      const cancelRemoved = await onIndexRemoved((event) => {
        if (event.root !== this.root) return;
        this.handleFileRemoved(event.file);
      });
      if (this.teardownRequested) {
        cancelRemoved();
        return;
      }
      this.pendingCancels.push(cancelRemoved);
    } catch (error) {
      console.warn("[symbol-index] failed to subscribe to events", error);
    }
    await this.refresh();
  }

  private async handleFileUpdated(_file: string): Promise<void> {
    // Re-query the whole index because the backend does not emit the
    // updated records — only the affected path. Pulling the small page
    // for `file` would miss renames that moved a symbol out of the file.
    try {
      this.status = await codingApi.indexStatus(this.root);
      const hits = await codingApi.symbolQuery(this.root, "", undefined, 5000);
      this.replaceAll(hits.map((hit) => hit.symbol));
    } catch (error) {
      console.warn("[symbol-index] file update failed", error);
    } finally {
      this.notify();
    }
  }

  private handleFileRemoved(file: string): void {
    this.byFile.delete(file);
    this.rebuildIndex();
    this.notify();
  }

  private replaceAll(symbols: SymbolRecord[]): void {
    this.byFile.clear();
    for (const symbol of symbols) {
      const list = this.byFile.get(symbol.file);
      if (list) {
        list.push(symbol);
      } else {
        this.byFile.set(symbol.file, [symbol]);
      }
    }
    this.rebuildIndex();
  }

  private rebuildIndex(): void {
    this.all = Array.from(this.byFile.values()).flat();
    this.all.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

function scoreSymbol(symbol: SymbolRecord, needle: string): number {
  const name = symbol.name.toLowerCase();
  if (name === needle) return 200;
  if (name.startsWith(needle)) return 120;
  if (name.includes(needle)) return 80;
  // Subsequence: every needle char appears in order inside the name.
  let cursor = 0;
  for (const character of needle) {
    const found = name.indexOf(character, cursor);
    if (found < 0) return 0;
    cursor = found + 1;
  }
  return 30;
}
