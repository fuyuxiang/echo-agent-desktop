// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

vi.mock('@/services/agent/skills', () => ({
  skillsAPI: { getDeps: vi.fn(), installDeps: vi.fn() }
}))
vi.mock('@/components/Toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() }
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k })
}))

import { skillsAPI } from '@/services/agent/skills'
import { useSkillDeps } from '../useSkillDeps'

describe('useSkillDeps', () => {
  beforeEach(() => vi.clearAllMocks())

  it('依赖已满足直接返回 true,不请求确认', async () => {
    ;(skillsAPI.getDeps as any).mockResolvedValue({ name: 'x', requires: [], missing: [], satisfied: true })
    const requestConfirm = vi.fn()
    const { result } = renderHook(() => useSkillDeps(requestConfirm))
    let ok: boolean | undefined
    await act(async () => { ok = await result.current.ensureDeps('x') })
    expect(ok).toBe(true)
    expect(requestConfirm).not.toHaveBeenCalled()
  })

  it('缺依赖且用户拒绝确认,返回 false 不安装', async () => {
    ;(skillsAPI.getDeps as any).mockResolvedValue({ name: 'x', requires: ['p'], missing: ['p'], satisfied: false })
    const requestConfirm = vi.fn().mockResolvedValue(false)
    const { result } = renderHook(() => useSkillDeps(requestConfirm))
    let ok: boolean | undefined
    await act(async () => { ok = await result.current.ensureDeps('x') })
    expect(ok).toBe(false)
    expect(skillsAPI.installDeps).not.toHaveBeenCalled()
  })

  it('缺依赖且用户确认,安装成功返回 true', async () => {
    ;(skillsAPI.getDeps as any).mockResolvedValue({ name: 'x', requires: ['p'], missing: ['p'], satisfied: false })
    ;(skillsAPI.installDeps as any).mockResolvedValue({ success: true, installed: ['p'], skipped: [], rejected: [], detail: 'ok' })
    const requestConfirm = vi.fn().mockResolvedValue(true)
    const { result } = renderHook(() => useSkillDeps(requestConfirm))
    let ok: boolean | undefined
    await act(async () => { ok = await result.current.ensureDeps('x') })
    expect(ok).toBe(true)
    expect(skillsAPI.installDeps).toHaveBeenCalledWith('x')
  })
})
