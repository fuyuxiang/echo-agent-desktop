import { listKbProviders, registerKbProvider, unregisterKbProvider } from "./knowledge-base";
import { createLocalKbProvider } from "./local-kb-provider";
import { createTauriDirectoryReader, isTauriAvailable } from "./tauri-kb-reader";
import { invoke } from "@tauri-apps/api/core";

const STORAGE_KEY = "echoagent.knowledge-sources.v1";
let hydrationPromise: Promise<KnowledgeSourceDescriptor[]> | null = null;

export interface KnowledgeSourceDescriptor {
  id: string;
  kind: "local-folder";
  root: string;
  label: string;
  enabled: boolean;
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
    id: `local-${hashPath(normalized.toLowerCase())}`,
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
    }];
  });
}

export function loadKnowledgeSourceDescriptors(): KnowledgeSourceDescriptor[] {
  if (typeof localStorage === "undefined") return [];
  try {
    return parseDescriptors(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]"));
  } catch {
    return [];
  }
}

function cacheKnowledgeSourceDescriptors(items: KnowledgeSourceDescriptor[]): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
}

async function saveKnowledgeSourceDescriptors(items: KnowledgeSourceDescriptor[]): Promise<void> {
  if (isTauriAvailable()) {
    await invoke<void>("org_local_kb_sources_set", { sources: items });
  }
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
      const stored = parseDescriptors(await invoke<unknown>("org_local_kb_sources_get"));
      if (stored.length > 0 || cached.length === 0) {
        descriptors = stored;
      } else {
        // One-time migration from releases that used renderer storage only.
        await invoke<void>("org_local_kb_sources_set", { sources: cached });
      }
      cacheKnowledgeSourceDescriptors(descriptors);
    }
    const registered = new Set(listKbProviders().map((source) => source.id));
    for (const descriptor of descriptors) {
      if (!registered.has(descriptor.id)) registerDescriptor(descriptor);
    }
    return descriptors;
  })().catch((error) => {
    hydrationPromise = null;
    throw error;
  });
  return hydrationPromise;
}

export async function addLocalKnowledgeSource(root: string): Promise<{ descriptor: KnowledgeSourceDescriptor; added: boolean }> {
  await hydrateKnowledgeSources();
  const descriptor = localKnowledgeSourceDescriptor(root);
  const items = loadKnowledgeSourceDescriptors();
  if (items.some((item) => item.id === descriptor.id)) {
    registerDescriptor(descriptor);
    return { descriptor, added: false };
  }
  await saveKnowledgeSourceDescriptors([...items, descriptor]);
  registerDescriptor(descriptor);
  return { descriptor, added: true };
}

export async function removeKnowledgeSource(id: string): Promise<boolean> {
  await hydrateKnowledgeSources();
  const items = loadKnowledgeSourceDescriptors();
  const next = items.filter((item) => item.id !== id);
  if (next.length !== items.length) await saveKnowledgeSourceDescriptors(next);
  return unregisterKbProvider(id) || next.length !== items.length;
}
