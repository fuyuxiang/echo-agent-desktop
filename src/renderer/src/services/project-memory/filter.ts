export interface CognitiveEntry {
  id: string
  content: string
  tags: string[]
  importance: number
}

export interface ShareCandidate {
  content: string
  tags: string[]
}

export const SHARE_TAGS = ['project', 'shared']

export function selectShareableMemories(entries: CognitiveEntry[]): ShareCandidate[] {
  const seen = new Set<string>()
  const out: ShareCandidate[] = []
  for (const entry of entries) {
    const content = entry.content?.trim()
    if (!content) continue
    if (!entry.tags?.some((t) => SHARE_TAGS.includes(t))) continue
    if (seen.has(content)) continue
    seen.add(content)
    out.push({ content, tags: entry.tags })
  }
  return out
}
