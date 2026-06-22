export interface PptOptions {
  topic: string
  pages: number
  lang: 'zh' | 'en'
  themeColor: string
  withImages: boolean
  extra: string
}

/** 把 PPT 参数面板字段拼成给 ppt-author 的结构化任务 prompt */
export function buildPptPrompt(opts: PptOptions): string {
  const langText = opts.lang === 'zh' ? '中文' : '英文'
  const imageText = opts.withImages ? '需要配图' : '不需要配图,用形状/色块'
  const lines = [
    '请使用「ppt-author」技能,生成一份 PowerPoint 演示文稿。',
    `- 主题:${opts.topic}`,
    `- 页数:约 ${opts.pages} 页`,
    `- 语言:${langText}`,
    `- 主题色:${opts.themeColor},整体配色与排版保持专业、统一`,
    `- 配图:${imageText}`
  ]
  if (opts.extra.trim()) {
    lines.push(`- 补充要求:${opts.extra.trim()}`)
  }
  lines.push(
    '',
    '请先 skill_view 读取 references/design-guide.md,严格按其中配色、版式、排版规范完成大纲与排版,',
    '最终用 scripts/create_pptx.py 或等价 python-pptx 代码生成 .pptx 并告知文件路径。'
  )
  return lines.join('\n')
}
