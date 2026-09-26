import type { ChatMessage, ToolCallView } from "@/stores/session-store";
import type { DiffContent } from "@/lib/types";

/** A file produced by a successful tool call in the current transcript. */
export interface SessionArtifact {
  id: string;
  path: string;
  /** Tool kind that last produced this path (edit / export / …). */
  kind: string;
  /** Last tool call title. */
  title: string;
  toolCallId: string;
  status: ToolCallView["status"];
  /** Set only by the output-aware collector; absent on legacy catalog rows. */
  verifiedOutput?: true;
}

/**
 * Collect unique output files from completed tool calls in the transcript.
 *
 * A path merely appearing in a Read/Open/Search input is not proof that the
 * task produced it. Treating every path-shaped argument as an output was the
 * source of configuration files and source inputs leaking into “Artifacts”.
 * We therefore trust structured diffs first, and only inspect path arguments
 * for tools whose kind/title explicitly describes a write-like operation.
 */
export function collectSessionArtifacts(messages: ChatMessage[]): SessionArtifact[] {
  const byPath = new Map<string, SessionArtifact>();

  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    for (const part of msg.parts) {
      if (part.kind !== "tool_call") continue;
      const tc = part.toolCall;
      if (tc.status !== "completed") continue;
      if (isDeletionTool(tc)) {
        for (const path of extractSourcePaths(tc, ["Delete", "Remove", "Unlink"])) {
          byPath.delete(pathKey(path));
        }
        continue;
      }
      if (isMoveTool(tc)) {
        for (const path of extractSourcePaths(tc)) byPath.delete(pathKey(path));
      }
      for (const path of extractPathsFromToolCall(tc)) {
        const key = pathKey(path);
        byPath.set(key, {
          id: key,
          path,
          kind: tc.kind,
          title: tc.title,
          toolCallId: tc.toolCallId,
          status: tc.status,
          verifiedOutput: true,
        });
      }
    }
  }

  return Array.from(byPath.values());
}

function extractPathsFromToolCall(tc: ToolCallView): string[] {
  const out = new Set<string>();

  // A declared read/delete operation is never a viewable output, even if a
  // buggy provider happens to attach diff-shaped diagnostic content.
  if (isNonArtifactTool(tc)) return [];

  for (const c of tc.content) {
    if (c.type === "diff") {
      const d = c as DiffContent;
      if (d.diff?.path && looksLikePath(d.diff.path)) out.add(d.diff.path);
    }
  }

  // Diffs are semantic proof of a write. For all other fields, be
  // conservative: shell/read/search tools often carry paths but do not expose
  // a reliable machine-readable output manifest.
  if (isCommandTool(tc.kind)) return [...out];
  if (!isOutputProducingTool(tc)) return [...out];

  // Write-like tool inputs may carry their destination in one of these fields.
  if (tc.rawInput && typeof tc.rawInput === "object") {
    const o = tc.rawInput as Record<string, unknown>;
    const destinationKeys = isTransferTool(tc)
      ? ["target", "destination", "dest", "to", "new_path", "newPath", "output", "output_path", "outputPath"]
      : [
        "path", "file", "file_path", "filepath", "target", "filename",
        "destination", "dest", "to", "output", "output_path", "outputPath",
      ];
    for (const key of destinationKeys) {
      const v = o[key];
      if (typeof v === "string" && looksLikePath(v)) out.add(v);
    }
    // Explicit output arrays are safe; generic `files`/`paths` arrays are
    // commonly source inputs and must not be promoted to artifacts.
    for (const key of ["outputs", "output_paths", "generated_files"]) {
      const v = o[key];
      if (Array.isArray(v)) {
        for (const item of v) {
          if (typeof item === "string" && looksLikePath(item)) out.add(item);
        }
      }
    }
  }

  // Last-resort compatibility for runtimes that put a write destination only
  // in the human title (for example: Write `C:\work\report.md`).
  const m = extractTitlePath(tc.title, [
    "Write", "Edit", "Create", "Save", "Export", "Generate", "Download", "Apply[_ -]?Patch",
  ]);
  if (m?.[1]) {
    const candidate = cleanTitlePath(m[1]);
    if (looksLikePath(candidate)) out.add(candidate);
  }

  return [...out];
}

const READ_ONLY_TOOL = /(?:^|[_\s-])(read|open|view|list|search|find|grep|glob|stat|inspect|browse)(?:$|[_\s-])/i;
const DELETE_TOOL = /(?:^|[_\s-])(delete|remove|unlink)(?:$|[_\s-])/i;
const OUTPUT_TOOL = /(?:^|[_\s-])(write|edit|create|save|export|generate|copy|move|rename|download|apply[_\s-]?patch)(?:$|[_\s-])/i;
const COMMAND_TOOL = /(?:^|[_\s-])(run[_\s-]?terminal[_\s-]?command|terminal|shell|bash|exec|command)(?:$|[_\s-])/i;
const DIRECTORY_TOOL = /(?:^|[_\s-])(mkdir|make[_\s-]?dir|create[_\s-]?(?:dir|directory|folder))(?:$|[_\s-])/i;

/** Whether non-diff path arguments are destinations rather than inputs. */
function isOutputProducingTool(tc: ToolCallView): boolean {
  const kind = tc.kind.trim();
  const titleAction = tc.title.trim().split(/\s+/, 1)[0] ?? "";
  return OUTPUT_TOOL.test(kind) || OUTPUT_TOOL.test(titleAction);
}

function isNonArtifactTool(tc: ToolCallView): boolean {
  const kind = tc.kind.trim();
  const titleAction = tc.title.trim().split(/\s+/, 1)[0] ?? "";
  return READ_ONLY_TOOL.test(kind)
    || READ_ONLY_TOOL.test(titleAction)
    || DELETE_TOOL.test(kind)
    || DELETE_TOOL.test(titleAction)
    || DIRECTORY_TOOL.test(kind)
    || /^(?:create|make)\s+(?:directory|folder)\b/i.test(tc.title.trim());
}

function isCommandTool(kind: string): boolean {
  return COMMAND_TOOL.test(kind.trim());
}

function isDeletionTool(tc: ToolCallView): boolean {
  const kind = tc.kind.trim();
  const titleAction = tc.title.trim().split(/\s+/, 1)[0] ?? "";
  return DELETE_TOOL.test(kind) || DELETE_TOOL.test(titleAction);
}

function isMoveTool(tc: ToolCallView): boolean {
  return /(?:^|[_\s-])(move|rename)(?:$|[_\s-])/i.test(tc.kind)
    || /^(?:move|rename)$/i.test(tc.title.trim().split(/\s+/, 1)[0] ?? "");
}

function isTransferTool(tc: ToolCallView): boolean {
  return /(?:^|[_\s-])(copy|move|rename)(?:$|[_\s-])/i.test(tc.kind)
    || /^(?:copy|move|rename)$/i.test(tc.title.trim().split(/\s+/, 1)[0] ?? "");
}

function extractSourcePaths(tc: ToolCallView, titleActions: string[] = []): string[] {
  const paths = new Set<string>();
  if (tc.rawInput && typeof tc.rawInput === "object") {
    const input = tc.rawInput as Record<string, unknown>;
    for (const key of ["path", "file", "file_path", "filepath", "source", "src", "from"]) {
      const value = input[key];
      if (typeof value === "string" && looksLikePath(value)) paths.add(value);
    }
    for (const key of ["paths", "files", "sources"]) {
      const value = input[key];
      if (!Array.isArray(value)) continue;
      for (const item of value) {
        if (typeof item === "string" && looksLikePath(item)) paths.add(item);
      }
    }
  }
  const titlePath = extractTitlePath(tc.title, titleActions);
  if (titlePath?.[1]) {
    const candidate = cleanTitlePath(titlePath[1]);
    if (looksLikePath(candidate)) paths.add(candidate);
  }
  return [...paths];
}

function extractTitlePath(title: string, actions: string[]): RegExpMatchArray | null {
  if (actions.length === 0) return null;
  const action = `(?:${actions.join("|")})`;
  const quote = "[`'\"]";
  const quotedValue = "([^`'\"]+)";
  return title.match(new RegExp(`${action}\\s+${quote}${quotedValue}${quote}`, "i"))
    ?? title.match(new RegExp(`${action}\\s+([A-Za-z]:\\\\\\S+|/\\S+|~/\\S+|\\S+\\.[A-Za-z0-9]{1,16})(?:\\s|$)`, "i"));
}

function cleanTitlePath(path: string): string {
  return path.trim().replace(/[),.;:]+$/, "");
}

function pathKey(path: string): string {
  return path.replace(/\\/g, "/");
}

function looksLikePath(s: string): boolean {
  if (!s || s.length < 2 || s.length > 512) return false;
  if (s.includes("\n")) return false;
  // Windows drive, UNC, unix absolute, home, or relative with extension/slash
  return (
    /^[A-Za-z]:[\\/]/.test(s) ||
    s.startsWith("\\\\") ||
    s.startsWith("/") ||
    s.startsWith("~/") ||
    /[\\/]/.test(s) ||
    /\.[A-Za-z0-9]{1,8}$/.test(s)
  );
}

/** Find a tool call by id across the transcript. */
export function findToolCall(
  messages: ChatMessage[],
  toolCallId: string,
): ToolCallView | undefined {
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.kind === "tool_call" && part.toolCall.toolCallId === toolCallId) {
        return part.toolCall;
      }
    }
  }
  return undefined;
}
