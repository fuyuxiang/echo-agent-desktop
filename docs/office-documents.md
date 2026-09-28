# 内置办公文档能力

EchoAgent 可在任务中读取工作区内的常见办公文档，并在本机生成 Word、PDF、Excel 和 PowerPoint 文件。生成器随桌面安装包分发，不需要用户安装 Office、LibreOffice、Python 或单独的文档转换服务；模型调用仍使用当前任务配置的模型服务。

## 怎么使用

1. 在 Agent 任务中指定已授权的工作目录，提出“做一份 Word 报告”“将表格整理成 Excel”等要求。Agent 可调用内置 `office_create`，将生成的文件保存到该工作区的 `EchoAgent成果/`，并返回实际路径。文件名附带唯一标识，不会覆盖同名成果。
2. 对一条回复使用「导出」，选择 Word、PDF、Excel 或 PPT，通过系统保存对话框指定位置。
3. 会议纪要另有 Word、PDF 和 Markdown 导出入口。

| 输出 | 内容组织方式 |
| --- | --- |
| Word / PDF | 从 Markdown 的标题、段落、列表、代码和表格生成内容 |
| Excel | 从 Markdown 表格生成工作表；长编号、前导零和公式样本按文本处理 |
| PPT | 按标题划分幻灯片 |

内容型文档适合此入口。原件的精确版式修改、扫描件 OCR、PDF 页面重排等应使用对应的专门工具或流程。完整嵌入中文字体的 PDF 文件可能较大。

## 文件与权限边界

`office_create` 只能写入当前任务获准工作区的成果目录。桌面回复导出使用用户选择的保存路径。输出在写盘前检查格式、非空与不超过 50 MiB，并计算 SHA-256；输入 Markdown 上限为 2 MiB。文档内容在本机由安装包内的 Node.js、文档 worker 和字体处理。

实现入口见 [`office_mcp.rs`](../src-tauri/src/office_mcp.rs)、[`document_export.rs`](../src-tauri/src/document_export.rs) 和 [`office-worker.mjs`](../scripts/office-worker.mjs)。开发者可运行 `pnpm office:test` 验证四种生成格式。
