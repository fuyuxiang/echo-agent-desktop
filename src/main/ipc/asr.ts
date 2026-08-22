import { ipcMain } from 'electron'
import { IpcChannels } from '@shared/ipc-channels'
import { createStream, feedAudio, getResult, stopStream } from '../asr'
import {
  saveASRConfig,
  getASRConfig,
  clearASRConfig,
  type ASRConfigInput,
  type ASRConfigPersisted
} from '../asr/config-store'

export function registerAsrHandlers(): void {
  // createStream/stopStream 现在是 async(createStream 需要异步解 apiKeyRef),
  // ipc handler 也对应改 async;Chat 渲染层已经 await,无破坏。
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

  // ASR 配置 IPC:apiKey 走 safeStorage,普通 store 仅存 ref 指针
  ipcMain.handle(IpcChannels.asr.saveConfig, (_event, cfg: ASRConfigInput) => {
    saveASRConfig(cfg)
  })

  ipcMain.handle(IpcChannels.asr.getConfig, (): ASRConfigPersisted | undefined => {
    return getASRConfig()
  })

  ipcMain.handle(IpcChannels.asr.clearConfig, () => {
    clearASRConfig()
  })
}