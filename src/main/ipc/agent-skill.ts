// src/main/ipc/agent-skill.ts
import { ipcMain } from 'electron'
import { IpcChannels } from '@shared/ipc-channels'
import { getSkillManager } from '../agent/skills/singleton'

/** 注册 agent:skill:* handler。 */
export function registerAgentSkillIpc(): void {
  ipcMain.handle(IpcChannels.agentSkill.list, () => getSkillManager().list())

  ipcMain.handle(IpcChannels.agentSkill.active, (_e, opts: { chatId: string }) =>
    getSkillManager().activeIds(opts.chatId)
  )

  ipcMain.handle(IpcChannels.agentSkill.activate, (_e, opts: { chatId: string; skillId: string }) => {
    getSkillManager().activate(opts.chatId, opts.skillId)
    return { success: true }
  })

  ipcMain.handle(
    IpcChannels.agentSkill.deactivate,
    (_e, opts: { chatId: string; skillId: string }) => {
      getSkillManager().deactivate(opts.chatId, opts.skillId)
      return { success: true }
    }
  )
}
