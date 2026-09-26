import { readDurable, writeDurable } from "./durable-ui-state";
const KEY = "echoagent.draft-attachments.v1";
type Drafts = Record<string, string[]>;
function read(): Drafts {
  return readDurable<Drafts>(KEY, {}, (value): value is Drafts => !!value && typeof value === "object"
    && !Array.isArray(value) && Object.values(value).every((paths) => Array.isArray(paths)
      && paths.every((path) => typeof path === "string")));
}
export function draftAttachments(key: string): string[] { return read()[key] ?? []; }
export function saveDraftAttachments(key: string, paths: string[]): void {
  const data = read();
  if (paths.length) data[key] = paths; else delete data[key];
  writeDurable(KEY, data);
}
