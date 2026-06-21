import { ipcMain } from 'electron'
import { IpcChannels } from '@shared/ipc-channels'
import { createStream, feedAudio, getResult, stopStream } from '../asr'

export function registerAsrHandlers(): void {
  ipcMain.handle(IpcChannels.asr.start, () => {
    return createStream()
  })

  ipcMain.handle(IpcChannels.asr.feed, (_event, streamId: string, samples: Float32Array) => {
    feedAudio(streamId, samples)
  })

  ipcMain.handle(IpcChannels.asr.getResult, (_event, streamId: string) => {
    return getResult(streamId)
  })

  ipcMain.handle(IpcChannels.asr.stop, (_event, streamId: string) => {
    return stopStream(streamId)
  })
}
