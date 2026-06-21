/**
 * 技能描述中文映射(仅前端展示用)
 *
 * 后端 SKILL.md 的 description 是英文,且会注入给 LLM 用于判断何时调用技能,
 * 故不改后端。这里只做一层 name -> 中文描述 的展示映射:
 * 命中则显示中文,未命中(如新增技能)回退到后端英文描述。
 */
const SKILL_DESCRIPTIONS_ZH: Record<string, string> = {
  arxiv: '通过 arXiv 免费 API 检索学术论文,支持按关键词、作者、分类或 ID 搜索,无需密钥。',
  calculator: '数学计算、单位换算、日期时间运算与汇率查询,基于 Python,数学运算无需联网。',
  calendar: '通过 CalDAV(Google/iCloud/Nextcloud)或本地 ICS 文件管理日历,查看、创建与查询日程。',
  'code-runner': '在沙箱环境中执行 Python 代码片段,支持数据分析、可视化与快速脚本。',
  'daily-briefing': '每日简报:聚合天气、提醒、新闻与日程,可定时通过任意渠道推送。',
  'deep-research': '结构化多步研究:搜索 → 提取 → 交叉验证 → 带引用地综合成文。',
  'docker-manage': '管理 Docker 容器、镜像、卷与 Compose 编排,需要 Docker CLI 权限。',
  'email-assistant': '通过 Himalaya CLI 或 Python IMAP/SMTP 读取、搜索、起草与发送邮件,需配置邮箱账号。',
  'excel-author': '使用 openpyxl 创建与编辑 Excel(.xlsx),支持公式、图表、格式与数据分析。',
  'file-convert': '文件格式互转:CSV↔JSON、Markdown↔HTML、YAML↔JSON、图片等,无需外部服务。',
  'finance-tracker': '记账与消费分析:归类交易、洞察支出模式,支持银行 CSV 导出或手动录入。',
  'fitness-nutrition': '按肌群/器械检索健身动作,查询食物营养数据,基于免费的 wger 与 USDA API。',
  flashcards: '间隔重复记忆卡片系统,采用 SM-2 算法,支持普通卡与挖空卡。',
  'github-ops': '通过 GitHub CLI 处理 issue、PR、代码搜索、CI 日志、发布与 API 查询,需 gh CLI 并已登录。',
  'image-gen': '通过 DALL-E、Stable Diffusion 或免费替代方案生成图片,支持多渠道推送。',
  'image-gen-pollinations-tips':
    'Pollinations.ai 免费生图的实用技巧与避坑:限流、串行批处理、输出校验、提示词撰写。',
  'maps-poi': '通过 OpenStreetMap/Nominatim 进行地理编码、POI 检索、路径规划与时区查询,免费无需密钥。',
  'meme-gen': '使用 Pillow 生成带文字的表情包,可选模板或自定义图片梗图。',
  'note-taking': '管理本地 Markdown 知识库:创建、搜索、关联与组织笔记,无需外部服务。',
  'notion-sync': '读取、创建与更新 Notion 页面和数据库,需要 Notion API 集成令牌。',
  'ocr-document': '从 PDF、图片与扫描件中提取文字,使用本地 pymupdf 或可选的云端 OCR API。',
  plan: '计划模式:检视上下文,将 Markdown 计划写入工作区的 `.echo-agent/plans/` 目录,但不执行。',
  'ppt-author': '以编程方式创建与编辑 PowerPoint(.pptx)演示文稿,需要 python-pptx。',
  reminder: '用自然语言设置提醒与待办,基于内置 cron 调度,无需外部服务。',
  'rss-watcher': '监控 RSS/Atom 订阅源的新文章,定时轮询、汇总更新并通过任意渠道推送。',
  'skill-creator': '创建或更新 AgentSkill,用于设计、组织与打包技能(含脚本、参考资料与素材)。',
  stocks: '通过免费 API 查询股价、基金净值与加密货币行情,支持 A 股、美股、港股与数字货币。',
  summarize: '从 URL、播客与本地文件中总结或提取文字/字幕(转写 YouTube/视频的理想兜底方案)。',
  'system-monitor': '监控系统健康:CPU、内存、磁盘、进程与网络,超阈值时通过任意渠道告警。',
  'text-tools': '文本处理工具箱:翻译、改写、正则、编解码与格式化。',
  'tts-voice': '将文字转为自然语音,使用 Edge-TTS(免费)或 OpenAI TTS,中文语音支持出色。',
  'voice-note': '语音转文字(STT)与文字转语音(TTS),支持 Whisper 本地模型与 Edge-TTS。',
  weather: '获取实时天气与预报,无需 API 密钥。',
  'web-extract': '从任意网址提取干净的正文内容,基于 trafilatura 高质量抽取,无需密钥。',
  'web-search': '通过 DuckDuckGo 免费网络搜索(网页/新闻/图片),无需密钥,可选自建 SearXNG。',
  'wiki-zh-lookup':
    '通过中文维基百科 Action API 查询结构化信息,适用于 web_fetch 被拦截但仍需可靠中文百科答案的场景(影视、人物、地点等),返回 JSON,无需密钥。',
  'workflow-chain': '将多个技能与动作串成命名工作流,支持错误处理与条件分支。'
}

export default SKILL_DESCRIPTIONS_ZH
