import type { SegmentDTO } from '@shared/types/meeting'

/**
 * 生成会议纪要:经主进程桌面直连 LLM 完成(不经 echo-agent,不发整段转写)。
 * 主进程在摘要完成后会用一条简短消息告知 echo-agent。此处只负责触发 + 存本地。
 */
export async function generateSummary(
  meetingId: string,
  segments: SegmentDTO[],
  title = ''
): Promise<void> {
  const parsed = await window.api.meeting.summarize(meetingId, title, segments)
  if (!parsed) {
    throw new Error('summary failed')
  }
  await window.api.meeting.setSummary(meetingId, { ...parsed, model: 'desktop-llm' })
}
