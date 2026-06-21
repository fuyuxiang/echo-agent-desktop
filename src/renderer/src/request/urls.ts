/**
 * 全部 host / API 路径统一收口(唯一来源)
 *
 * 规则:
 * - host 从 .env 读取,按环境切换,业务代码禁止出现散落的 URL 字符串
 * - 新接口一律在 ApiUrls 中按模块添加常量,services/ 只引用此处
 */

/** 后台 API host(.env 中按环境配置) */
export const API_HOST = import.meta.env.VITE_API_BASE_URL

/** echo-agent Gateway API 路径（/api/v1 前缀） */
export const AgentApiUrls = {
  health: '/api/v1/health',
  stats: '/api/v1/stats',

  message: '/api/v1/message',
  sessions: '/api/v1/sessions',
  sessionDetail: (key: string) => `/api/v1/sessions/${encodeURIComponent(key)}`,
  sessionMessages: (key: string) => `/api/v1/sessions/${encodeURIComponent(key)}/messages`,
  sessionDelete: (key: string) => `/api/v1/sessions/${encodeURIComponent(key)}`,

  memory: '/api/v1/memory',
  memoryStats: '/api/v1/memory/stats',
  memorySearch: '/api/v1/memory/search',
  memoryDetail: (id: string) => `/api/v1/memory/${id}`,

  skills: '/api/v1/skills',
  skillDetail: (name: string) => `/api/v1/skills/${name}`,
  skillToggle: (name: string) => `/api/v1/skills/${name}/toggle`,
  skillImport: '/api/v1/skills/import',
  skillDelete: (name: string) => `/api/v1/skills/${name}`,

  channels: '/api/v1/channels',

  knowledgeStatus: '/api/v1/knowledge/status',
  knowledgeRebuild: '/api/v1/knowledge/rebuild',
  knowledgeUpload: '/api/v1/knowledge/upload',
  knowledgeDocuments: '/api/v1/knowledge/documents',
  knowledgeDocDelete: (path: string) => `/api/v1/knowledge/documents/${encodeURIComponent(path)}`,

  config: '/api/v1/config',
  configModels: '/api/v1/config/models',

  shutdown: '/api/v1/shutdown'
} as const

/** API 路径常量(按业务模块分组) */
export const ApiUrls = {
  /** 示例模块(配合 pages/Example,后台就绪后可删除) */
  example: {
    /** 获取问候语 */
    greeting: '/api/example/greeting',
    /** 获取列表 */
    list: '/api/example/list'
  }
} as const

/** echo-agent-server(项目记忆服务)API 路径 */
export const ServerApiUrls = {
  login: '/api/auth/login',
  modelConfig: '/api/model-config',
  projectMemory: '/api/project-memory',
  projectMemorySearch: '/api/project-memory/search',
  adminUsers: '/api/admin/users',
  adminGroups: '/api/admin/groups',
  adminModelConfig: '/api/admin/model-config'
} as const
