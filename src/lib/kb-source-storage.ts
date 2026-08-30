import { listKbProviders, registerKbProvider, unregisterKbProvider } from "./knowledge-base";
import { createLocalKbProvider } from "./local-kb-provider";
import { createTauriDirectoryReader, isTauriAvailable } from "./tauri-kb-reader";
import { invoke } from "@tauri-apps/api/core";

const STORAGE_KEY = "echoagent.knowledge-sources.v1";

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

export function loadKnowledgeSourceDescriptors(): KnowledgeSourceDescriptor[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is KnowledgeSourceDescriptor => {
      const value = item as Partial<KnowledgeSourceDescriptor>;
      return value.kind === "local-folder" && typeof value.id === "string" && typeof value.root === "string";
    });
  } catch {
    return [];
  }
}

function saveKnowledgeSourceDescriptors(items: KnowledgeSourceDescriptor[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  if (isTauriAvailable()) {
    void Promise.resolve(invoke("org_local_kb_sources_set", { sources: items })).catch(() => undefined);
  }
}

function registerDescriptor(descriptor: KnowledgeSourceDescriptor): void {
  if (!descriptor.enabled || !isTauriAvailable()) return;
  registerKbProvider(createLocalKbProvider(
    descriptor.root,
    createTauriDirectoryReader(),
    { id: descriptor.id, label: descriptor.label },
  ));
}

export function hydrateKnowledgeSources(): void {
  const descriptors = loadKnowledgeSourceDescriptors();
  if (isTauriAvailable()) {
    void Promise.resolve(invoke("org_local_kb_sources_set", { sources: descriptors })).catch(() => undefined);
  }
  const registered = new Set(listKbProviders().map((source) => source.id));
  for (const descriptor of descriptors) {
    if (!registered.has(descriptor.id)) registerDescriptor(descriptor);
  }
}

export function addLocalKnowledgeSource(root: string): { descriptor: KnowledgeSourceDescriptor; added: boolean } {
  const descriptor = localKnowledgeSourceDescriptor(root);
  const items = loadKnowledgeSourceDescriptors();
  if (items.some((item) => item.id === descriptor.id)) {
    registerDescriptor(descriptor);
    return { descriptor, added: false };
  }
  saveKnowledgeSourceDescriptors([...items, descriptor]);
  registerDescriptor(descriptor);
  return { descriptor, added: true };
}

export function removeKnowledgeSource(id: string): boolean {
  const items = loadKnowledgeSourceDescriptors();
  const next = items.filter((item) => item.id !== id);
  if (next.length !== items.length) saveKnowledgeSourceDescriptors(next);
  return unregisterKbProvider(id) || next.length !== items.length;
}
