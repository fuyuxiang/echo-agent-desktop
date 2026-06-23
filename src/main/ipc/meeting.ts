import { ipcMain, app } from 'electron'
import path from 'path'
import fs from 'fs'
import { randomUUID } from 'crypto'
import { log } from '../logger'
import { IpcChannels } from '@shared/ipc-channels'
import type { MeetingSummaryInput } from '@shared/types/meeting'
import {
  createMeeting,
  listMeetings,
  getMeeting,
  appendSegment,
  getSegments,
  finishMeeting,
  updateMeetingStatus,
  updateMeetingAudioSource,
  updateSegmentSpeaker,
  upsertSummary,
  getSummary,
  removeMeeting,
  renameMeeting
} from '../db/dao/meeting'
import { startRecording, appendPcm, finishRecording } from '../meeting/recorder'
import {
  createMeetingStream,
  feedMeetingAudio,
  pollMeetingStream,
  stopMeetingStream
} from '../asr'

function meetingsDir(): string {
  return path.join(app.getPath('userData'), 'meetings')
}

const sessions = new Map<string, { streamId: string; segIdx: number; startedAt: number }>()

export function registerMeetingHandlers(): void {
  ipcMain.handle(IpcChannels.meeting.start, () => {
    const meetingId = randomUUID()
    const startedAt = Date.now()
    const audioPath = startRecording(meetingId, meetingsDir())
    const streamId = createMeetingStream()
    createMeeting({
      id: meetingId,
      title: `会议 ${new Date(startedAt).toLocaleString()}`,
      audioPath,
      audioSource: 'mic'
    })
    sessions.set(meetingId, { streamId, segIdx: 0, startedAt })
    return { meetingId }
  })

  ipcMain.handle(IpcChannels.meeting.feed, (_e, meetingId: string, samples: Float32Array) => {
    const s = sessions.get(meetingId)
    if (!s) return
    feedMeetingAudio(s.streamId, samples)
    appendPcm(meetingId, samples)
  })

  ipcMain.handle(IpcChannels.meeting.poll, (_e, meetingId: string) => {
    const s = sessions.get(meetingId)
    if (!s) return { segments: [], partial: '' }
    const { confirmed, partial } = pollMeetingStream(s.streamId)
    for (const c of confirmed) {
      appendSegment({ meetingId, idx: s.segIdx++, startMs: c.startMs, endMs: c.endMs, text: c.text })
    }
    return { segments: getSegments(meetingId), partial }
  })

  ipcMain.handle(IpcChannels.meeting.stop, (_e, meetingId: string) => {
    const s = sessions.get(meetingId)
    if (!s) return { meetingId, status: 'failed' }
    const { confirmed } = stopMeetingStream(s.streamId)
    for (const c of confirmed) {
      appendSegment({ meetingId, idx: s.segIdx++, startMs: c.startMs, endMs: c.endMs, text: c.text })
    }
    finishRecording(meetingId)
    const endedAt = Date.now()
    finishMeeting({
      id: meetingId,
      endedAt,
      durationMs: endedAt - s.startedAt,
      status: 'processing'
    })
    sessions.delete(meetingId)
    return { meetingId, status: 'processing' }
  })

  // diarization 在 Task 8 实现;此处留桩:不改 speaker,直接标 done
  // 停止后对完整录音离线跑说话人分离,回填每段 speaker。
  // 分离失败不阻塞:仍置 done,speaker 留空,转写与纪要不受影响。
  ipcMain.handle(IpcChannels.meeting.diarize, async (_e, meetingId: string) => {
    const meeting = getMeeting(meetingId)
    if (!meeting?.audioPath || !fs.existsSync(meeting.audioPath)) {
      updateMeetingStatus(meetingId, 'done')
      return { segments: getSegments(meetingId) }
    }
    try {
      const { runDiarization, alignSpeaker } = await import('../meeting/diarization')
      const diar = await runDiarization(meeting.audioPath)
      for (const seg of getSegments(meetingId)) {
        const speaker = alignSpeaker(seg.startMs, seg.endMs, diar)
        if (speaker) updateSegmentSpeaker(seg.id, speaker)
      }
    } catch (err) {
      log.error('[meeting] 说话人分离失败:', err)
    }
    updateMeetingStatus(meetingId, 'done')
    return { segments: getSegments(meetingId) }
  })

  ipcMain.handle(
    IpcChannels.meeting.setSummary,
    (_e, meetingId: string, data: MeetingSummaryInput) => {
      upsertSummary({ meetingId, ...data })
    }
  )

  ipcMain.handle(IpcChannels.meeting.list, () => ({ meetings: listMeetings() }))

  ipcMain.handle(IpcChannels.meeting.get, (_e, meetingId: string) => ({
    meeting: getMeeting(meetingId),
    segments: getSegments(meetingId),
    summary: getSummary(meetingId)
  }))

  ipcMain.handle(IpcChannels.meeting.remove, (_e, meetingId: string) => {
    const m = getMeeting(meetingId)
    if (m?.audioPath && fs.existsSync(m.audioPath)) {
      try {
        fs.unlinkSync(m.audioPath)
      } catch {
        /* 忽略文件删除失败 */
      }
    }
    removeMeeting(meetingId)
  })

  ipcMain.handle(IpcChannels.meeting.rename, (_e, meetingId: string, title: string) =>
    renameMeeting(meetingId, title)
  )

  ipcMain.handle(IpcChannels.meeting.markSource, (_e, meetingId: string, source: string) =>
    updateMeetingAudioSource(meetingId, source)
  )
}
