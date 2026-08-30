import type { InspirationRichCard } from "./types";

/** Parse the agent's streamed JSON defensively. A short prefix/suffix or a
 * markdown fence is tolerated, but malformed and empty cards are rejected. */
export function parseInspirationCards(
  value: string,
  category: string,
  createdAtMs: number = Date.now(),
): InspirationRichCard[] {
  const raw = value.trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const arrayStart = raw.indexOf("[");
  const arrayEnd = raw.lastIndexOf("]");
  const json = arrayStart >= 0 && arrayEnd > arrayStart
    ? raw.slice(arrayStart, arrayEnd + 1)
    : raw;
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) return [];
  const createdAt = new Date(createdAtMs).toISOString();
  return parsed
    .map((value: unknown, index: number) => {
      const item = value && typeof value === "object"
        ? value as Record<string, unknown>
        : {};
      return {
        cardId: `gen-${createdAtMs}-${index}`,
        title: String(item.title ?? "").trim(),
        summary: String(item.summary ?? "").trim(),
        detail: String(item.takeaway ?? item.detail ?? "").trim(),
        category,
        prompt: String(item.prompt ?? item.title ?? "").trim(),
        createdAt,
      };
    })
    .filter((card) => card.title.length > 0 && card.summary.length > 0)
    .slice(0, 10);
}
