import { useState, useCallback } from 'react'
import { skillsAPI } from '@/services/agent/skills'
import { toast } from '@/components/Toast'
import { useTranslation } from 'react-i18next'

/** 调用方提供:展示授权弹窗并返回用户是否同意安装 */
export type RequestConfirm = (skillName: string, missing: string[]) => Promise<boolean>

export interface UseSkillDeps {
  checking: boolean
  installing: boolean
  /** 确保技能依赖就绪;返回 true 表示可继续启用/使用 */
  ensureDeps: (name: string) => Promise<boolean>
}

export function useSkillDeps(requestConfirm: RequestConfirm): UseSkillDeps {
  const { t } = useTranslation()
  const [checking, setChecking] = useState(false)
  const [installing, setInstalling] = useState(false)

  const ensureDeps = useCallback(
    async (name: string): Promise<boolean> => {
      setChecking(true)
      let deps
      try {
        deps = await skillsAPI.getDeps(name)
      } catch {
        toast.error(t('skill.deps.checkFailed'))
        return true // 体检失败不阻断启用(降级)
      } finally {
        setChecking(false)
      }
      if (deps.satisfied) return true

      const agreed = await requestConfirm(name, deps.missing)
      if (!agreed) return false

      setInstalling(true)
      try {
        const res = await skillsAPI.installDeps(name)
        if (res.success) {
          toast.success(t('skill.deps.installed'))
          return true
        }
        toast.error(t('skill.deps.failed', { detail: res.detail }))
        return false
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e)
        toast.error(t('skill.deps.failed', { detail }))
        return false
      } finally {
        setInstalling(false)
      }
    },
    [requestConfirm, t]
  )

  return { checking, installing, ensureDeps }
}
