import { readDurable, writeDurable } from "./durable-ui-state";
import { touchDraft } from "./draft-lifecycle";
const KEY = "echoagent.draft-attachments.v1";
type Drafts = Record<string, string[]>;
// Keep edits available in this renderer if storage is full. The shared storage
// health notice reports the failure; a later successful write retries them.
const unsaved = new Map<string, string[]>();
function read(): Drafts {
  return readDurable<Drafts>(KEY, {}, (value): value is Drafts => !!value && typeof value === "object"
    && !Array.isArray(value) && Object.values(value).every((paths) => Array.isArray(paths)
      && paths.every((path) => typeof path === "string")));
}
export function draftAttachments(key: string): string[] { return unsaved.get(key) ?? read()[key] ?? []; }
export function saveDraftAttachments(key: string, paths: string[]): void {
  const data = read();
  const previous = unsaved.get(key) ?? data[key] ?? [];
  if (!unsaved.size && previous.length === paths.length && previous.every((path, index) => path === paths[index])) return;
  for (const [scope, pending] of unsaved) {
    if (pending.length) data[scope] = pending; else delete data[scope];
  }
  if (paths.length) data[key] = [...paths]; else delete data[key];
  if (writeDurable(KEY, data)) unsaved.clear(); else unsaved.set(key, [...paths]);
  touchDraft(key);
}
