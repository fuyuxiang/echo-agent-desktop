import type { ChatProvider } from '../agent/providers/types'
import type { SegmentDTO } from '@shared/types/meeting'
import { getLLMProvider, getLLMConfig } from './llm'

export interface ParsedSummary {
  summary: string
  keyPoints: string[]
  actionItems: string[]
}

export function buildSummaryPrompt(segments: SegmentDTO[]): string {
  const transcript = segments
    .map((s) => `${s.speaker ? `[${s.speaker}] ` : ''}${s.text}`)
    .join('\n')
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
  return block
    .split('\n')
    .map((l) => l.replace(/^[-*]\s*/, '').trim())
    .filter((l) => l && l !== '无')
}

export function parseSummary(text: string): ParsedSummary {
  return {
    summary: extractSection(text, '摘要'),
    keyPoints: toList(extractSection(text, '关键点')),
    actionItems: toList(extractSection(text, '待办'))
  }
}

export function buildNotifyMessage(title: string, parsed: ParsedSummary): string {
  const todos = parsed.actionItems.length ? parsed.actionItems.map((t) => `- ${t}`).join('\n') : '无'
  return [
    `刚刚开了一个会议:${title}`,
    '',
    '会议摘要:',
    parsed.summary,
    '',
    '待办事项:',
    todos
  ].join('\n')
}

export async function summarizeMeeting(
  segments: SegmentDTO[],
  deps?: { provider?: ChatProvider }
): Promise<ParsedSummary | null> {
  const provider = deps?.provider ?? getLLMProvider()
  if (!provider) return null
  const signal = AbortSignal.timeout(120_000)
  try {
    let out = ''
    for await (const delta of provider.chat(
      {
        model: getLLMConfig()?.model ?? '',
        messages: [{ role: 'user', content: buildSummaryPrompt(segments) }],
        temperature: 0.3
      },
      signal
    )) {
      if (delta.type === 'text') out += delta.text
      else if (delta.type === 'error') return null
    }
    return parseSummary(out)
  } catch {
    return null
  }
}
