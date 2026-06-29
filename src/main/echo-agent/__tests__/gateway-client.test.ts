import { describe, it, expect } from 'vitest'
import { translateFrame } from '../gateway-client'

describe('translateFrame', () => {
  it('control frames produce no events', () => {
    expect(translateFrame({ type: 'auth_ok', session_key: 'k' }, 'c1')).toEqual([])
    expect(translateFrame({ type: 'accepted', event_id: 'e1' }, 'c1')).toEqual([])
    expect(translateFrame({ type: 'pong' }, 'c1')).toEqual([])
  })

  it('final message yields final + done, preserving text and chatId', () => {
    const out = translateFrame(
      { type: 'message', text: '你好', is_final: true, message_kind: 'final', event_id: 'e1' },
      'c1'
    )
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ type: 'final', text: '你好', chatId: 'c1' })
    expect(out[1]).toMatchObject({ type: 'done', chatId: 'c1' })
  })

  it('progress message (message_kind) yields progress preserving metadata', () => {
    const meta = { progress_type: 'tool_call', tool: 'shell' }
    const out = translateFrame(
      { type: 'message', text: '', is_final: false, message_kind: 'progress', metadata: meta },
      'c1'
    )
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ type: 'progress', chatId: 'c1' })
    expect(out[0].metadata).toEqual(meta)
  })

  it('progress via metadata._progress flag also maps to progress', () => {
    const out = translateFrame(
      { type: 'message', text: '', is_final: false, metadata: { _progress: true } },
      'c1'
    )
    expect(out[0]).toMatchObject({ type: 'progress' })
  })

  it('non-final non-progress text maps to streaming', () => {
    const out = translateFrame(
      { type: 'message', text: 'partial', is_final: false }, 'c1'
    )
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ type: 'streaming', text: 'partial', chatId: 'c1' })
  })

  it('error frame maps to error preserving message', () => {
    const out = translateFrame({ type: 'error', error: 'unauthorized' }, 'c1')
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ type: 'error', chatId: 'c1' })
    expect(out[0].message ?? out[0].error).toBe('unauthorized')
  })
})
