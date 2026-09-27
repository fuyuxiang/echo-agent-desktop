# 内置办公文档能力

EchoAgent 将办公文档处理作为任务的底层能力。用户只需在对话中提出“做一份 Word 报告”“把会议纪要导出 PDF”或“整理成 Excel/PPT”；界面不出现工具安装、第三方登录或服务端转换配置。

## 使用路径

- Agent 可读取当前任务有权访问的本地 DOCX、XLSX、PPTX 和 PDF，基于内容进行摘要、问答和整理。现有本地知识索引也支持这些输入。
- Agent 调用内置 `office_create` 生成 DOCX、PDF、XLSX 或 PPTX，文件自动保存到任务工作区的 `EchoAgent成果` 目录，并进入任务成果列表。每次生成使用独立文件名，避免覆盖已有文件。
- 用户也可以从已完成的回复中选择“导出 → Word/PDF/Excel/PPT”，通过系统保存对话框决定路径。会议纪要提供 Word、PDF、Markdown 导出。
- 文档生成在本机完成，使用安装包内的 Node.js 运行时和中文 PDF 字体；不需要安装 Office、LibreOffice、Python、额外 Node.js，也不需要办公服务账号。Agent 本身仍遵循项目既有的模型连接方式。

## 数据与边界

输入使用 Markdown。标题、段落、列表、代码和表格进入 Word/PDF；Excel 将 Markdown 表格分别放到工作表；PPT 按标题切分幻灯片。Excel 的普通数值写为数字，长编号、前导零和公式样本保留为文本，避免误执行。输出经格式、大小和 SHA-256 校验后写盘。

内置能力覆盖常见的内容型文档。复杂版式、原文件精确保真修改、扫描件 OCR、PDF 页面重排与批注仍由现有文件工具和专项流程处理，不能以“生成新文件”冒充原件编辑。Notion、Obsidian、邮箱、日历、天气等外部服务不属于基础办公文档能力；只有明确业务场景和用户授权时再接入。

PDF 为确保中文在不同阅读器中正确显示，会完整嵌入中文字体；即使内容较短，文件也可能达到十余 MiB。

## 维护与验证

`pnpm office:test` 会打包内置 worker，并以中英文、Markdown 表格生成四种格式，检查 PDF 可解析、Excel 数据可读以及 Office 文件头。`pnpm build` 检查前端，`cargo check --locked --manifest-path src-tauri/Cargo.toml` 检查桌面端。Tauri 开发和构建钩子会自动打包 worker，发布包将其与字体及许可文件一起纳入资源目录。
