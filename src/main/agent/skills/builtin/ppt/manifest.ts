// src/main/agent/skills/builtin/ppt/manifest.ts
import type { SkillManifest } from '../../types'

export const pptManifest: SkillManifest = {
  id: 'ppt',
  label: 'PPT 生成',
  description: '将结构化大纲渲染为 PowerPoint (.pptx) 演示文稿',
  kind: 'code',
  triggers: ['ppt', '幻灯片', '演示文稿', 'powerpoint'] // 预留,P4 不自动触发
}
