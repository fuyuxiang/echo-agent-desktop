export type Frame = Record<string, unknown>

const CONTROL_TYPES = new Set(['auth_ok', 'accepted', 'pong', 'auth'])

export function translateFrame(frame: Frame, chatId: string): Frame[] {
  const type = frame.type as string | undefined

  if (type === 'error' || (frame.error != null && frame.error !== '')) {
    return [{ ...frame, type: 'error', chatId, message: frame.error ?? frame.message }]
  }
  if (type && CONTROL_TYPES.has(type)) {
    return []
  }
  if (type !== 'message') {
    return []
  }

  const meta = (frame.metadata as Record<string, unknown> | undefined) ?? undefined
  const isProgress = frame.message_kind === 'progress' || meta?._progress === true
  if (isProgress) {
    return [{ ...frame, type: 'progress', chatId }]
  }
  if (frame.is_final === true) {
    return [
      { ...frame, type: 'final', chatId },
      { type: 'done', chatId }
    ]
  }
  // non-final, non-progress text → streaming increment
  return [{ ...frame, type: 'streaming', chatId }]
}
