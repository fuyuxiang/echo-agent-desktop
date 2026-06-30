import type { ProjectMemory } from '@/services/server'

export function buildProjectMemoryContext(hits: ProjectMemory[], userText: string): string {
  if (!hits.length) return userText
  const lines = hits.map((h) => `- ${h.content}`).join('\n')
  return [
    '【团队项目记忆（供参考，可能与本次任务相关）】',
    lines,
    '',
    userText
  ].join('\n')
}
