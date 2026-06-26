import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const handlers = new Map<string, (...args: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn) }
}))

import { IpcChannels } from '@shared/ipc-channels'
import { registerAgentSkillIpc } from '../agent-skill'
import { resetSkillManagerForTest } from '../../agent/skills/singleton'

beforeEach(() => {
  handlers.clear()
  resetSkillManagerForTest()
  registerAgentSkillIpc()
})
afterEach(() => resetSkillManagerForTest())

function invoke(ch: string, ...args: unknown[]): unknown {
  return handlers.get(ch)!({}, ...args)
}

describe('agent-skill IPC', () => {
  it('list 返回内置技能 manifest', () => {
    const list = invoke(IpcChannels.agentSkill.list) as Array<{ id: string }>
    expect(list.some((m) => m.id === 'ppt')).toBe(true)
  })
  it('activate 后 active 返回该 id,deactivate 后清空', () => {
    invoke(IpcChannels.agentSkill.activate, { chatId: 'c1', skillId: 'ppt' })
    expect(invoke(IpcChannels.agentSkill.active, { chatId: 'c1' })).toEqual(['ppt'])
    invoke(IpcChannels.agentSkill.deactivate, { chatId: 'c1', skillId: 'ppt' })
    expect(invoke(IpcChannels.agentSkill.active, { chatId: 'c1' })).toEqual([])
  })
})
