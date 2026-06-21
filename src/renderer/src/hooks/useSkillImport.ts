import { useState, useCallback } from 'react'
import { useSkillStore } from '@/stores/skillStore'
import { skillsAPI } from '@/services/agent/skills'
import { fileDialog } from '@/utils/dialog'
import { toast } from '@/components/Toast'

export interface SkillImport {
  importing: boolean
  /** 选本地文件夹 -> 后端 import -> 重拉列表 -> 未启用则自动启用 */
  handleImport: () => Promise<void>
}

/**
 * 导入技能(技能库页与聊天技能选择器共用)
 * 后端 import 接口只认本地目录,桌面端与 agent 同机,直接传绝对路径。
 */
export function useSkillImport(): SkillImport {
  const setSkills = useSkillStore((s) => s.setSkills)
  const [importing, setImporting] = useState(false)

  const handleImport = useCallback(async (): Promise<void> => {
    if (importing) return
    const [dir] = await fileDialog.open({
      properties: ['openDirectory'],
      title: '选择技能文件夹（需包含 SKILL.md）'
    })
    if (!dir) return

    setImporting(true)
    try {
      const res = await skillsAPI.importFromPath(dir)
      const imported = res.skill?.name
      // import 返回的 enabled 不可靠,以重拉列表的真实状态为准
      const list = await skillsAPI.list()
      let latest = list.skills ?? []
      setSkills(latest)

      // 未启用则自动启用(满足"导入即启用")
      const target = imported ? latest.find((s) => s.name === imported) : undefined
      if (target && !target.enabled) {
        await skillsAPI.toggle(target.name)
        const refreshed = await skillsAPI.list()
        latest = refreshed.skills ?? []
        setSkills(latest)
      }
      toast.success(imported ? `技能已导入并启用：${imported}` : '技能已导入')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (/409|exist/i.test(msg)) {
        toast.error('该技能已存在')
      } else if (/400|SKILL\.md|invalid/i.test(msg)) {
        toast.error('所选文件夹不是有效技能（缺少 SKILL.md）')
      } else {
        toast.error(`导入失败：${msg}`)
      }
    } finally {
      setImporting(false)
    }
  }, [importing, setSkills])

  return { importing, handleImport }
}
