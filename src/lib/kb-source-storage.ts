import { listKbProviders, registerKbProvider, unregisterKbProvider } from "./knowledge-base";
import { createLocalKbProvider } from "./local-kb-provider";
import { createTauriDirectoryReader, isTauriAvailable } from "./tauri-kb-reader";
import { invoke } from "@tauri-apps/api/core";
import { useKnowledgeStore } from "@/stores/knowledge-store";

const STORAGE_KEY = "echoagent.knowledge-sources.v1";
let hydrationPromise: Promise<KnowledgeSourceDescriptor[]> | null = null;
let hydratedDescriptors: KnowledgeSourceDescriptor[] | null = null;
// The native command replaces the complete catalog. Serialize read/modify/write
// operations so independent controls cannot save snapshots that undo each other.
let mutationTail: Promise<unknown> = Promise.resolve();

function mutateSources<T>(action: () => Promise<T>): Promise<T> {
  const result = mutationTail.then(action);
  mutationTail = result.catch(() => undefined);
  return result;
}

export interface KnowledgeSourceDescriptor {
  id: string;
  kind: "local-folder";
  root: string;
  label: string;
  enabled: boolean;
  resourceId?: string;
}

function hashPath(path: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < path.length; i++) {
    hash ^= path.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function normalizedRoot(root: string): string {
  const normalized = root.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized || "/";
}

export function localKnowledgeSourceDescriptor(root: string): KnowledgeSourceDescriptor {
  const normalized = normalizedRoot(root);
  const label = normalized.split("/").filter(Boolean).pop() ?? normalized;
  return {
    id: `local-${hashPath(normalized)}`,
    kind: "local-folder",
    root: normalized,
    label: `本地：${label}`,
    enabled: true,
  };
}

function parseDescriptors(value: unknown): KnowledgeSourceDescriptor[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const source = item as Partial<KnowledgeSourceDescriptor>;
    if (
      typeof source.id !== "string"
      || typeof source.root !== "string"
      || !source.root.trim()
      || (source.kind !== undefined && source.kind !== "local-folder")
    ) return [];
    return [{
      id: source.id,
      kind: "local-folder" as const,
      root: normalizedRoot(source.root),
      label: typeof source.label === "string" && source.label.trim()
        ? source.label.trim()
        : `本地：${source.root.split(/[\\/]/).filter(Boolean).pop() ?? source.root}`,
      enabled: source.enabled !== false,
      resourceId: typeof source.resourceId === "string" ? source.resourceId : undefined,
    }];
  });
}

export function loadKnowledgeSourceDescriptors(): KnowledgeSourceDescriptor[] {
  if (hydratedDescriptors) return hydratedDescriptors.map((item) => ({ ...item }));
  if (typeof localStorage === "undefined") return [];
  try {
    return parseDescriptors(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]"));
  } catch {
    return [];
  }
}

function cacheKnowledgeSourceDescriptors(items: KnowledgeSourceDescriptor[]): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch (error) {
    // Native storage is authoritative in the desktop app; a full renderer
    // cache must not turn an already-persisted update into a failed operation.
    if (!isTauriAvailable()) throw error;
  }
}

async function saveKnowledgeSourceDescriptors(items: KnowledgeSourceDescriptor[]): Promise<void> {
  if (isTauriAvailable()) {
    await invoke<void>("org_local_kb_sources_set", { sources: items });
  }
  hydratedDescriptors = items.map((item) => ({ ...item }));
  cacheKnowledgeSourceDescriptors(items);
}

function registerDescriptor(descriptor: KnowledgeSourceDescriptor): void {
  if (!descriptor.enabled || !isTauriAvailable()) return;
  registerKbProvider(createLocalKbProvider(
    descriptor.root,
    createTauriDirectoryReader(),
    { id: descriptor.id, label: descriptor.label },
  ));
}

export function hydrateKnowledgeSources(): Promise<KnowledgeSourceDescriptor[]> {
  if (hydrationPromise) return hydrationPromise;
  hydrationPromise = (async () => {
    const cached = loadKnowledgeSourceDescriptors();
    let descriptors = cached;
    if (isTauriAvailable()) {
      const raw = await invoke<unknown>("org_local_kb_sources_get", { includeStorageState: true });
      const snapshot = raw && typeof raw === "object" && !Array.isArray(raw)
        ? raw as { exists?: unknown; sources?: unknown }
        : null;
      const stored = parseDescriptors(snapshot ? snapshot.sources : raw);
      if (snapshot?.exists === true || stored.length > 0 || cached.length === 0) {
        descriptors = stored;
      } else {
        // One-time migration from releases that used renderer storage only.
        await invoke<void>("org_local_kb_sources_set", { sources: cached });
      }
      cacheKnowledgeSourceDescriptors(descriptors);
    }
    hydratedDescriptors = descriptors.map((item) => ({ ...item }));
    const registered = new Set(listKbProviders().map((source) => source.id));
    for (const descriptor of descriptors) {
      if (!registered.has(descriptor.id)) registerDescriptor(descriptor);
    }
    useKnowledgeStore.getState().setSourceCount(listKbProviders().length);
    return descriptors;
  })().catch((error) => {
    hydrationPromise = null;
    throw error;
  });
  return hydrationPromise;
}

/** Test/support reset; does not alter persisted knowledge sources. */
export function resetKnowledgeSourceHydration(): void {
  hydrationPromise = null;
  hydratedDescriptors = null;
}

export function addLocalKnowledgeSource(root: string): Promise<{ descriptor: KnowledgeSourceDescriptor; added: boolean }> {
  return mutateSources(() => addLocalSource(root));
}

async function addLocalSource(root: string): Promise<{ descriptor: KnowledgeSourceDescriptor; added: boolean }> {
  await hydrateKnowledgeSources();
  let descriptor = localKnowledgeSourceDescriptor(root);
  if (isTauriAvailable()) {
    const identity = await invoke<{ id: string; canonicalPath: string }>("filesystem_resource_identity", { path: root, directory: true });
    descriptor = { ...localKnowledgeSourceDescriptor(identity.canonicalPath), id: `local-${identity.id}`, resourceId: identity.id };
  }
  const items = loadKnowledgeSourceDescriptors();
  for (const item of items) {
    if (isTauriAvailable() && !item.resourceId) {
      try { item.resourceId = (await invoke<{ id: string }>("filesystem_resource_identity", { path: item.root, directory: true })).id; } catch { /* Offline source remains in the catalog. */ }
    }
    if (item.id === descriptor.id || item.root === descriptor.root || (item.resourceId && item.resourceId === descriptor.resourceId)) {
      registerDescriptor(item);
      return { descriptor: item, added: false };
    }
  }
  await saveKnowledgeSourceDescriptors([...items, descriptor]);
  registerDescriptor(descriptor);
  useKnowledgeStore.getState().setSourceCount(listKbProviders().length);
  return { descriptor, added: true };
}

export function removeKnowledgeSource(id: string): Promise<boolean> {
  return mutateSources(() => removeSource(id));
}

async function removeSource(id: string): Promise<boolean> {
  await hydrateKnowledgeSources();
  const items = loadKnowledgeSourceDescriptors();
  const next = items.filter((item) => item.id !== id);
  if (next.length !== items.length) await saveKnowledgeSourceDescriptors(next);
  const removed = unregisterKbProvider(id) || next.length !== items.length;
  useKnowledgeStore.getState().setSourceCount(listKbProviders().length);
  return removed;
}
