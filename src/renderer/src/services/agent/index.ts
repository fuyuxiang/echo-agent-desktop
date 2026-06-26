// src/renderer/src/services/agent/index.ts
// P6 sweep: 清理死导出,chatAPI/configAPI 保留为兼容 stub
export { chatAPI } from './chat'
export { memoryAPI, type MemoryEntry, type MemoryListResponse, type MemorySearchResponse } from './memory'
export { skillsAPI, type Skill, type SkillDetail } from './skills'
export { channelsAPI, type Channel } from './channels'
export { knowledgeAPI, type KnowledgeStatus, type KnowledgeDocument } from './knowledge'
export { configAPI } from './config'
export { agentWs } from './runtime-client'
