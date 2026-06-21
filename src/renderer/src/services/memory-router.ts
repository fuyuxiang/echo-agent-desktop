import { writeProjectMemory } from './server'

export interface MemoryCandidate {
  content: string
  tags: string[]
  reason?: string
}

export type ShareDecision = 'share' | 'local' | 'discard'

export async function confirmShareToProject(
  candidate: MemoryCandidate,
  decision: ShareDecision
): Promise<{ shared: boolean }> {
  if (decision === 'share') {
    await writeProjectMemory(candidate.content, candidate.tags)
    return { shared: true }
  }
  return { shared: false }
}
