/** Markers used to keep an expert persona in the model prompt but out of UI. */
export const EXPERT_PERSONA_BEGIN = "<!--EXPERT_PERSONA_BEGIN-->";
export const EXPERT_PERSONA_END = "<!--EXPERT_PERSONA_END-->";

/** Metadata key persisted on ACP prompt text blocks for attachment replay. */
export const ATTACHMENTS_META_KEY = "echoAgentAttachments";

/** Legacy suffix written by the desktop bridge before structured metadata. */
export const LEGACY_ATTACHMENT_HEADING =
  "附件（图片已作为多模态内容附加；其他文件请使用 read_file 读取）：";

export function attachmentBasename(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized.split("/").pop() || path;
}

export function normalizeAttachmentPaths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string =>
    typeof item === "string" && item.trim().length > 0
  ))];
}

/** Remove context that is intentionally sent to the model but hidden in chat. */
export function stripInjectedUserContext(text: string): string {
  let visible = text;
  while (true) {
    const begin = visible.indexOf(EXPERT_PERSONA_BEGIN);
    if (begin === -1) break;
    const end = visible.indexOf(EXPERT_PERSONA_END, begin);
    if (end === -1) break;
    visible = visible.slice(0, begin) + visible.slice(end + EXPERT_PERSONA_END.length);
  }
  visible = visible.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "");
  return visible.replace(/^\n+|\n+$/g, "").trim();
}

/**
 * Recover attachment paths from prompts persisted by older desktop versions.
 * Only strip the suffix when every trailing non-empty row is an `- @path`
 * entry, so ordinary user text mentioning the heading is left untouched.
 */
export function parseLegacyAttachmentPrompt(text: string): {
  text: string;
  attachments: string[];
} {
  const marker = `\n\n${LEGACY_ATTACHMENT_HEADING}\n`;
  const markerIndex = text.lastIndexOf(marker);
  if (markerIndex === -1) {
    return { text: stripInjectedUserContext(text), attachments: [] };
  }

  const rows = text
    .slice(markerIndex + marker.length)
    .split("\n")
    .map((row) => row.trim())
    .filter(Boolean);
  if (rows.length === 0 || rows.some((row) => !row.startsWith("- @"))) {
    return { text: stripInjectedUserContext(text), attachments: [] };
  }

  const attachments = [...new Set(rows.map((row) => row.slice(3).trim()).filter(Boolean))];
  return {
    text: stripInjectedUserContext(text.slice(0, markerIndex)),
    attachments,
  };
}
