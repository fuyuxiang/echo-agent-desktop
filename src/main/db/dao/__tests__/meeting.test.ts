import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'

let memDb: Database.Database
vi.mock('../../index', () => ({ getDb: () => memDb }))

import {
  createMeeting, listMeetings, getMeeting, appendSegment, getSegments,
  updateSegmentSpeaker, finishMeeting, upsertSummary, getSummary,
  removeMeeting, renameMeeting, findRecordingMeetings
} from '../meeting'
import { runMigrations } from '../../migrations'

beforeEach(() => {
  memDb = new Database(':memory:')
  runMigrations(memDb)
})

describe('meeting DAO', () => {
  it('create + get + list', () => {
    createMeeting({ id: 'm1', title: '会议1' })
    const m = getMeeting('m1')!
    expect(m.title).toBe('会议1')
    expect(m.status).toBe('recording')
    expect(listMeetings()).toHaveLength(1)
  })
  it('appendSegment + getSegments 按 idx 升序', () => {
    createMeeting({ id: 'm1' })
    appendSegment({ meetingId: 'm1', idx: 1, startMs: 1000, endMs: 2000, text: '第二句' })
    appendSegment({ meetingId: 'm1', idx: 0, startMs: 0, endMs: 900, text: '第一句' })
    const segs = getSegments('m1')
    expect(segs.map((s) => s.text)).toEqual(['第一句', '第二句'])
    expect(segs[0].speaker).toBeNull()
  })
  it('updateSegmentSpeaker 回填说话人', () => {
    createMeeting({ id: 'm1' })
    const seg = appendSegment({ meetingId: 'm1', idx: 0, startMs: 0, endMs: 900, text: 'hi' })
    updateSegmentSpeaker(seg.id, 'speaker_1')
    expect(getSegments('m1')[0].speaker).toBe('speaker_1')
  })
  it('finishMeeting 写结束时间与状态', () => {
    createMeeting({ id: 'm1' })
    finishMeeting({ id: 'm1', endedAt: 5000, durationMs: 5000, status: 'processing' })
    const m = getMeeting('m1')!
    expect(m.status).toBe('processing')
    expect(m.durationMs).toBe(5000)
  })
  it('upsertSummary + getSummary 序列化数组', () => {
    createMeeting({ id: 'm1' })
    upsertSummary({ meetingId: 'm1', summary: '摘要', keyPoints: ['a', 'b'], actionItems: ['x'] })
    const s = getSummary('m1')!
    expect(s.summary).toBe('摘要')
    expect(s.keyPoints).toEqual(['a', 'b'])
    expect(s.actionItems).toEqual(['x'])
  })
  it('removeMeeting 级联删段与纪要', () => {
    createMeeting({ id: 'm1' })
    appendSegment({ meetingId: 'm1', idx: 0, startMs: 0, endMs: 1, text: 'hi' })
    upsertSummary({ meetingId: 'm1', summary: 's' })
    removeMeeting('m1')
    expect(getMeeting('m1')).toBeNull()
    expect(getSegments('m1')).toHaveLength(0)
    expect(getSummary('m1')).toBeNull()
  })
  it('renameMeeting 改标题', () => {
    createMeeting({ id: 'm1' })
    renameMeeting('m1', '新名')
    expect(getMeeting('m1')!.title).toBe('新名')
  })
  it('findRecordingMeetings 返回未结束会议', () => {
    createMeeting({ id: 'm1' })
    createMeeting({ id: 'm2' })
    finishMeeting({ id: 'm2', endedAt: 1, durationMs: 1, status: 'done' })
    expect(findRecordingMeetings().map((m) => m.id)).toEqual(['m1'])
  })
})
