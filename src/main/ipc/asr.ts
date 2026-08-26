import { ipcMain } from 'electron'
import { IpcChannels } from '@shared/ipc-channels'
import { createStream, feedAudio, getResult, stopStream } from '../asr'

/**
 * ASR IPC 注册(2026-08 v2)
 *
 * - API Key 由 safeStorage 或 ECHO_ASR_API_KEY 注入,不随应用分发
 * - 流式接口(createStream/start、stopStream/stop)保持 async 以便 IPC handler await
 */
export function registerAsrHandlers(): void {
  ipcMain.handle(IpcChannels.asr.start, async () => {
    return createStream()
  })

  ipcMain.handle(IpcChannels.asr.feed, (_event, streamId: string, samples: Float32Array) => {
    feedAudio(streamId, samples)
  })

  ipcMain.handle(IpcChannels.asr.getResult, (_event, streamId: string) => {
    return getResult(streamId)
  })

  ipcMain.handle(IpcChannels.asr.stop, async (_event, streamId: string) => {
    return stopStream(streamId)
  })
}
