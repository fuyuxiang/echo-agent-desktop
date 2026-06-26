// src/main/agent/skills/builtin/ppt/prompt.ts
export const PPT_PROMPT = `## PPT 生成技能已激活

当用户需要生成 PPT 时,调用 generate_ppt 工具。入参 outline 为结构化大纲:
{
  "title": "演示标题",
  "subtitle": "可选副标题",
  "theme": { "primaryColor": "1F4E79", "fontFace": "微软雅黑" },
  "slides": [
    { "layout": "title", "title": "...", "subtitle": "..." },
    { "layout": "content", "title": "...", "bullets": ["要点1","要点2"], "notes": "可选备注" },
    { "layout": "two-column", "title": "...", "left": ["..."], "right": ["..."] },
    { "layout": "table", "title": "...", "headers": ["列1","列2"], "rows": [["a","b"]] }
  ]
}

设计规范:
- 首页用 title 布局;每页要点 3-5 条,避免堆砌长句。
- 主题色用沉稳商务色(默认深蓝 1F4E79),中文默认微软雅黑。
- 总页数随主题繁简,一般 6-12 页;先列骨架再填内容。
- 数据对比用 table 或 two-column,不要把表格塞进 bullets。

工具返回 { path, slideCount },把文件路径告知用户。`
