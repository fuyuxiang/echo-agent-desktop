import { getDb } from '../index'

export interface MeetingRow {
  id: string; title: string | null; startedAt: number; endedAt: number | null
  durationMs: number; audioPath: string | null; audioSource: string
  status: string; createdAt: number
}
export interface SegmentRow {
  id: number; meetingId: string; idx: number; startMs: number; endMs: number
  text: string; speaker: string | null; createdAt: number
}
export interface SummaryRow {
  meetingId: string; summary: string; keyPoints: string[]; actionItems: string[]
  model: string | null; createdAt: number
}

interface RawMeeting {
  id: string; title: string | null; started_at: number; ended_at: number | null
  duration_ms: number; audio_path: string | null; audio_source: string
  status: string; created_at: number
}
interface RawSegment {
  id: number; meeting_id: string; idx: number; start_ms: number; end_ms: number
  text: string; speaker: string | null; created_at: number
}
interface RawSummary {
  meeting_id: string; summary: string; key_points: string | null
  action_items: string | null; model: string | null; created_at: number
}

function toMeeting(r: RawMeeting): MeetingRow {
  return {
    id: r.id, title: r.title, startedAt: r.started_at, endedAt: r.ended_at,
    durationMs: r.duration_ms, audioPath: r.audio_path, audioSource: r.audio_source,
    status: r.status, createdAt: r.created_at
  }
}
function toSegment(r: RawSegment): SegmentRow {
  return {
    id: r.id, meetingId: r.meeting_id, idx: r.idx, startMs: r.start_ms,
    endMs: r.end_ms, text: r.text, speaker: r.speaker, createdAt: r.created_at
  }
}
function toSummary(r: RawSummary): SummaryRow {
  return {
    meetingId: r.meeting_id, summary: r.summary,
    keyPoints: r.key_points ? JSON.parse(r.key_points) : [],
    actionItems: r.action_items ? JSON.parse(r.action_items) : [],
    model: r.model, createdAt: r.created_at
  }
}

export function createMeeting(input: {
  id: string; title?: string | null; audioPath?: string | null; audioSource?: string
}): void {
  const now = Date.now()
  getDb().prepare(
    `INSERT INTO meetings (id, title, started_at, ended_at, duration_ms, audio_path, audio_source, status, created_at)
     VALUES (@id, @title, @now, NULL, 0, @audioPath, @audioSource, 'recording', @now)`
  ).run({
    id: input.id, title: input.title ?? null,
    audioPath: input.audioPath ?? null, audioSource: input.audioSource ?? 'mic', now
  })
}

export function listMeetings(): MeetingRow[] {
  return (getDb().prepare('SELECT * FROM meetings ORDER BY started_at DESC').all() as RawMeeting[]).map(toMeeting)
}
export function getMeeting(id: string): MeetingRow | null {
  const r = getDb().prepare('SELECT * FROM meetings WHERE id = ?').get(id) as RawMeeting | undefined
  return r ? toMeeting(r) : null
}
export function appendSegment(input: {
  meetingId: string; idx: number; startMs: number; endMs: number; text: string
}): SegmentRow {
  const createdAt = Date.now()
  const result = getDb().prepare(
    `INSERT INTO meeting_segments (meeting_id, idx, start_ms, end_ms, text, speaker, created_at)
     VALUES (@meetingId, @idx, @startMs, @endMs, @text, NULL, @createdAt)`
  ).run({ ...input, createdAt })
  return {
    id: Number(result.lastInsertRowid), meetingId: input.meetingId, idx: input.idx,
    startMs: input.startMs, endMs: input.endMs, text: input.text, speaker: null, createdAt
  }
}
export function getSegments(meetingId: string): SegmentRow[] {
  return (getDb().prepare('SELECT * FROM meeting_segments WHERE meeting_id = ? ORDER BY idx ASC')
    .all(meetingId) as RawSegment[]).map(toSegment)
}
export function updateSegmentSpeaker(segmentId: number, speaker: string): void {
  getDb().prepare('UPDATE meeting_segments SET speaker = ? WHERE id = ?').run(speaker, segmentId)
}
export function finishMeeting(input: {
  id: string; endedAt: number; durationMs: number; status: string
}): void {
  getDb().prepare(
    `UPDATE meetings SET ended_at = @endedAt, duration_ms = @durationMs, status = @status WHERE id = @id`
  ).run(input)
}
export function updateMeetingStatus(id: string, status: string): void {
  getDb().prepare('UPDATE meetings SET status = ? WHERE id = ?').run(status, id)
}
export function updateMeetingAudioSource(id: string, audioSource: string): void {
  getDb().prepare('UPDATE meetings SET audio_source = ? WHERE id = ?').run(audioSource, id)
}
export function upsertSummary(input: {
  meetingId: string; summary: string; keyPoints?: string[]; actionItems?: string[]; model?: string
}): void {
  const now = Date.now()
  getDb().prepare(
    `INSERT INTO meeting_summaries (meeting_id, summary, key_points, action_items, model, created_at)
     VALUES (@meetingId, @summary, @keyPoints, @actionItems, @model, @now)
     ON CONFLICT(meeting_id) DO UPDATE SET
       summary = @summary, key_points = @keyPoints, action_items = @actionItems,
       model = @model, created_at = @now`
  ).run({
    meetingId: input.meetingId, summary: input.summary,
    keyPoints: JSON.stringify(input.keyPoints ?? []),
    actionItems: JSON.stringify(input.actionItems ?? []),
    model: input.model ?? null, now
  })
}
export function getSummary(meetingId: string): SummaryRow | null {
  const r = getDb().prepare('SELECT * FROM meeting_summaries WHERE meeting_id = ?')
    .get(meetingId) as RawSummary | undefined
  return r ? toSummary(r) : null
}
export function removeMeeting(id: string): void {
  const db = getDb()
  db.transaction(() => {
    db.prepare('DELETE FROM meeting_segments WHERE meeting_id = ?').run(id)
    db.prepare('DELETE FROM meeting_summaries WHERE meeting_id = ?').run(id)
    db.prepare('DELETE FROM meetings WHERE id = ?').run(id)
  })()
}
export function renameMeeting(id: string, title: string): void {
  getDb().prepare('UPDATE meetings SET title = ? WHERE id = ?').run(title, id)
}
export function findRecordingMeetings(): MeetingRow[] {
  return (getDb().prepare("SELECT * FROM meetings WHERE status = 'recording'").all() as RawMeeting[]).map(toMeeting)
}
