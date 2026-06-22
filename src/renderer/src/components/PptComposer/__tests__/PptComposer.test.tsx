// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { PptComposer } from '../index'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k })
}))

describe('PptComposer', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => cleanup())

  it('点触发按钮展开面板', () => {
    render(<PptComposer disabled={false} onGenerate={vi.fn()} />)
    expect(screen.queryByText('chat.ppt.title')).toBeNull()
    fireEvent.click(screen.getByText('chat.ppt.trigger'))
    expect(screen.getByText('chat.ppt.title')).toBeTruthy()
  })

  it('填主题后点生成,回调收到含主题的 prompt', () => {
    const onGenerate = vi.fn()
    render(<PptComposer disabled={false} onGenerate={onGenerate} />)
    fireEvent.click(screen.getByText('chat.ppt.trigger'))
    fireEvent.change(screen.getByPlaceholderText('chat.ppt.topicPlaceholder'), {
      target: { value: '年度总结' }
    })
    fireEvent.click(screen.getByText('chat.ppt.generate'))
    expect(onGenerate).toHaveBeenCalledTimes(1)
    expect(onGenerate.mock.calls[0][0]).toContain('年度总结')
  })

  it('主题为空点生成不触发回调', () => {
    const onGenerate = vi.fn()
    render(<PptComposer disabled={false} onGenerate={onGenerate} />)
    fireEvent.click(screen.getByText('chat.ppt.trigger'))
    fireEvent.click(screen.getByText('chat.ppt.generate'))
    expect(onGenerate).not.toHaveBeenCalled()
  })
})
