export interface MeetingDTO {
  id: string
  title: string | null
  startedAt: number
  endedAt: number | null
  durationMs: number
  audioPath: string | null
  audioSource: string
  status: string
  createdAt: number
}
export interface SegmentDTO {
  id: number
  meetingId: string
  idx: number
  startMs: number
  endMs: number
  text: string
  speaker: string | null
  createdAt: number
}
export interface SummaryDTO {
  meetingId: string
  summary: string
  keyPoints: string[]
  actionItems: string[]
  model: string | null
  createdAt: number
}
export interface MeetingSummaryInput {
  summary: string
  keyPoints: string[]
  actionItems: string[]
  model?: string
}
