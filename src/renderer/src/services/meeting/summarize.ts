import { AgentWebSocket } from '@/services/agent/ws'
import { useAgentStore } from '@/stores/agentStore'
import type { SegmentDTO } from '@shared/types/meeting'

export function buildSummaryPrompt(segments: SegmentDTO[]): string {
  const transcript = segments.map((s) => {
    const sp = s.speaker ? `[${s.speaker}] ` : ''
    return `${sp}${s.text}`
  }).join('\n')
  return [
    '以下是一段会议的完整转写,请生成会议纪要。',
    '严格按如下 Markdown 格式输出,不要额外解释:',
    '## 摘要',
    '(一段话概括会议)',
    '## 关键点',
    '- (每条一行)',
    '## 待办',
    '- (每条一行,无则写「无」)',
    '',
    '会议转写:',
    transcript
  ].join('\n')
}

function extractSection(text: string, header: string): string {
  const re = new RegExp(`##\\s*${header}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|$)`)
  return text.match(re)?.[1]?.trim() ?? ''
}
function toList(block: string): string[] {
  return block.split('\n').map((l) => l.replace(/^[-*]\s*/, '').trim())
    .filter((l) => l && l !== '无')
}

export function parseSummary(text: string): {
  summary: string; keyPoints: string[]; actionItems: string[]
} {
  return {
    summary: extractSection(text, '摘要'),
    keyPoints: toList(extractSection(text, '关键点')),
    actionItems: toList(extractSection(text, '待办'))
  }
}

function getPayloadText(payload: Record<string, unknown>): string {
  const value = payload.text ?? payload.delta ?? payload.content ?? payload.message
  return typeof value === 'string' ? value : ''
}

export function generateSummary(meetingId: string, segments: SegmentDTO[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const { baseUrl, remoteToken } = useAgentStore.getState()
    const ws = new AgentWebSocket()
    const wsUrl = baseUrl.replace(/^http/, 'ws') + '/ws'
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      ws.disconnect()
      reject(new Error('summary timeout'))
    }, 120_000)

    const onFinal = async (payload: Record<string, unknown>): Promise<void> => {
      if (settled) return
      const text = getPayloadText(payload)
      if (!text) return
      settled = true
      clearTimeout(timer)
      const parsed = parseSummary(text)
      await window.api.meeting.setSummary(meetingId, { ...parsed, model: 'agent' })
      ws.disconnect()
      resolve()
    }
    ws.on('message.final', onFinal)
    ws.on('final', onFinal)
    ws.connect(wsUrl, `meeting-summary-${meetingId}`, remoteToken)
    // 等 auth 完成后发送
    setTimeout(() => ws.sendMessage(buildSummaryPrompt(segments)), 800)
  })
}
