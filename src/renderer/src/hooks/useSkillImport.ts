import { useCallback } from 'react'
import { fileDialog } from '@/utils/dialog'
import { toast } from '@/components/Toast'

export interface SkillImport {
  importing: boolean
  /** P6 已下线: 技能动态加载已废除(代码型技能编译进 bundle, 提示词型从 builtin/ 静态登记) */
  handleImport: () => Promise<void>
}

/**
 * 技能导入(P6 占位 stub)
 *
 * Python 时代走 lazy_deps + 后端 import 路径, P6 后代码型技能编译进 bundle,
 * 提示词型在 src/main/agent/skills/builtin/ 静态登记。运行时导入接口下线。
 */
export function useSkillImport(): SkillImport {
  const handleImport = useCallback(async (): Promise<void> => {
    // 仍允许用户选目录(用于说明流程), 但实际不调后端 import
    await fileDialog.open({
      properties: ['openDirectory'],
      title: '选择技能文件夹(已下线,仅作说明)'
    })
    toast.error('技能运行时导入已下线,请编辑 src/main/agent/skills/builtin/ 静态登记')
  }, [])

  return { importing: false, handleImport }
}

