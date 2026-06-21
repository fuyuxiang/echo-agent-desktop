import { searchProjectMemory } from './server'

/** 检索项目记忆并拼成可注入的上下文段落；服务器不可达时降级返回空串 */
export async function buildProjectMemoryContext(query: string): Promise<string> {
  try {
    const mems = await searchProjectMemory(query)
    if (!mems.length) return ''
    const lines = mems.map((m) => `- ${m.content}`).join('\n')
    return `参考的项目记忆（同组共享知识）：\n${lines}`
  } catch {
    return '' // 服务器不可达降级：无项目记忆注入，本地推理照常
  }
}
