import { describe, expect, it } from 'vitest'
import { IpcChannels } from '../ipc-channels'

function collectStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (!value || typeof value !== 'object') return []
  return Object.values(value).flatMap((item) => collectStrings(item))
}

describe('IpcChannels', () => {
  it('所有 IPC channel 字符串唯一且使用 module:action 格式', () => {
    const channels = collectStrings(IpcChannels)
    expect(channels.length).toBeGreaterThan(0)
    expect(new Set(channels).size).toBe(channels.length)
    expect(channels.every((channel) => /^[a-z-]+(?::[a-z-]+)+$/.test(channel))).toBe(true)
  })
})
