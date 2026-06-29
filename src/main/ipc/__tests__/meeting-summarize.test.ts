import { describe, it, expect, vi, beforeEach } from 'vitest'

const handlers = new Map<string, (...a: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn) },
  app: { getPath: () => '/tmp' }
}))
const summarizeMeeting = vi.fn()
const buildNotifyMessage = vi.fn((..._a: unknown[]) => 'NOTIFY')
vi.mock('../../echo-agent/meeting-summary', () => ({
  summarizeMeeting: (...a: unknown[]) => summarizeMeeting(...a),
  buildNotifyMessage: (...a: unknown[]) => buildNotifyMessage(...a)
}))
const getEchoAgentEndpoint = vi.fn((..._a: unknown[]) => ({ baseUrl: 'http://127.0.0.1:1', token: 't' }))
vi.mock('../../echo-agent', () => ({
  getEchoAgentEndpoint: (...a: unknown[]) => getEchoAgentEndpoint(...a)
}))
const notifyMeeting = vi.fn()
vi.mock('../../echo-agent/adapters', () => ({
  notifyMeeting: (...a: unknown[]) => notifyMeeting(...a)
}))
// meeting dao mocked to no-op (handler under test only uses summarize path)
vi.mock('../../db/dao/meeting', () => ({
  createMeeting: vi.fn(), listMeetings: vi.fn(), getMeeting: vi.fn(), appendSegment: vi.fn(),
  getSegments: vi.fn(), finishMeeting: vi.fn(), updateMeetingStatus: vi.fn(),
  updateMeetingAudioSource: vi.fn(), updateSegmentSpeaker: vi.fn(), upsertSummary: vi.fn(),
  getSummary: vi.fn(), removeMeeting: vi.fn(), renameMeeting: vi.fn(),
  findRecordingMeetings: vi.fn(() => [])
}))

import { registerMeetingHandlers } from '../meeting'
import { IpcChannels } from '@shared/ipc-channels'

describe('meeting:summarize ipc', () => {
  beforeEach(() => { handlers.clear(); vi.clearAllMocks() })

  it('returns parsed summary and notifies echo-agent', async () => {
    summarizeMeeting.mockResolvedValue({ summary: 's', keyPoints: ['k'], actionItems: [] })
    registerMeetingHandlers()
    const r = await handlers.get(IpcChannels.meeting.summarize)!({}, 'm1', '评审会', [{ text: 'x' }])
    expect(r).toEqual({ summary: 's', keyPoints: ['k'], actionItems: [] })
    expect(notifyMeeting).toHaveBeenCalledWith({ baseUrl: 'http://127.0.0.1:1', token: 't' }, 'NOTIFY')
  })

  it('returns null and skips notify when summary fails', async () => {
    summarizeMeeting.mockResolvedValue(null)
    registerMeetingHandlers()
    const r = await handlers.get(IpcChannels.meeting.summarize)!({}, 'm1', 't', [])
    expect(r).toBeNull()
    expect(notifyMeeting).not.toHaveBeenCalled()
  })

  it('still returns parsed when notify throws', async () => {
    summarizeMeeting.mockResolvedValue({ summary: 's', keyPoints: [], actionItems: [] })
    notifyMeeting.mockRejectedValue(new Error('http down'))
    registerMeetingHandlers()
    const r = await handlers.get(IpcChannels.meeting.summarize)!({}, 'm1', 't', [])
    expect(r).toMatchObject({ summary: 's' })
  })

  it('returns parsed and skips notify when endpoint is null', async () => {
    summarizeMeeting.mockResolvedValue({ summary: 's', keyPoints: [], actionItems: [] })
    getEchoAgentEndpoint.mockReturnValue(null as unknown as { baseUrl: string; token: string })
    registerMeetingHandlers()
    const r = await handlers.get(IpcChannels.meeting.summarize)!({}, 'm1', 't', [])
    expect(r).toMatchObject({ summary: 's' })
    expect(notifyMeeting).not.toHaveBeenCalled()
  })
})
