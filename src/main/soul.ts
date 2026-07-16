import { randomUUID } from 'crypto'
import type {
  SoulConfig,
  SoulTemplate,
  SoulListResponse,
  SoulAddRequest,
  SoulUpdateRequest
} from '../shared/soul-types'
import { storeGet, storeSet } from './store'

const SOULS_KEY = 'soul.configs'
const TEMPLATES_KEY = 'soul.templates'

/** Predefined soul templates */
const DEFAULT_TEMPLATES: SoulTemplate[] = [
  {
    id: 'default',
    name: 'Default Assistant',
    content: 'You are a helpful AI assistant.',
    category: 'general',
    description: 'A general-purpose assistant'
  },
  {
    id: 'coder',
    name: 'Code Assistant',
    content: 'You are an expert programmer. Help users write, debug, and understand code.',
    category: 'development',
    description: 'Specialized in programming tasks'
  },
  {
    id: 'writer',
    name: 'Writing Assistant',
    content: 'You are a skilled writer. Help users with writing, editing, and content creation.',
    category: 'creative',
    description: 'Specialized in writing tasks'
  }
]

/** Read souls from store */
function getSouls(): SoulConfig[] {
  return storeGet<SoulConfig[]>(SOULS_KEY) ?? []
}

/** Read templates from store */
function getTemplates(): SoulTemplate[] {
  return storeGet<SoulTemplate[]>(TEMPLATES_KEY) ?? DEFAULT_TEMPLATES
}

/** List all souls and templates */
export async function listSouls(): Promise<SoulListResponse> {
  const souls = getSouls()
  const templates = getTemplates()
  return {
    souls,
    templates,
    total: souls.length
  }
}

/** Get a soul by id */
export async function getSoul(id: string): Promise<SoulConfig> {
  const souls = getSouls()
  const soul = souls.find(s => s.id === id)
  if (!soul) {
    throw new Error(`Soul not found: ${id}`)
  }
  return soul
}

/** Add a new soul */
export async function addSoul(request: SoulAddRequest): Promise<SoulConfig> {
  const souls = getSouls()
  const now = new Date().toISOString()
  const newSoul: SoulConfig = {
    id: randomUUID(),
    name: request.name,
    content: request.content,
    isActive: false,
    metadata: request.metadata,
    createdAt: now,
    updatedAt: now
  }
  souls.push(newSoul)
  storeSet(SOULS_KEY, souls)
  return newSoul
}

/** Update an existing soul */
export async function updateSoul(request: SoulUpdateRequest): Promise<SoulConfig> {
  const souls = getSouls()
  const index = souls.findIndex(s => s.id === request.id)
  if (index === -1) {
    throw new Error(`Soul not found: ${request.id}`)
  }
  const updated: SoulConfig = {
    ...souls[index],
    ...request,
    updatedAt: new Date().toISOString()
  }
  souls[index] = updated
  storeSet(SOULS_KEY, souls)
  return updated
}

/** Delete a soul by id */
export async function deleteSoul(id: string): Promise<void> {
  const souls = getSouls()
  const filtered = souls.filter(s => s.id !== id)
  storeSet(SOULS_KEY, filtered)
}

/** Set a soul as active (deactivates others) */
export async function setActiveSoul(id: string): Promise<SoulConfig> {
  const souls = getSouls()
  const index = souls.findIndex(s => s.id === id)
  if (index === -1) {
    throw new Error(`Soul not found: ${id}`)
  }
  // Deactivate all others
  const updated = souls.map(s => ({
    ...s,
    isActive: s.id === id,
    updatedAt: s.id === id ? new Date().toISOString() : s.updatedAt
  }))
  storeSet(SOULS_KEY, updated)
  return updated[index]
}

/** Add a new template */
export async function addTemplate(request: { name: string; content: string; category: string; description?: string }): Promise<SoulTemplate> {
  const templates = getTemplates()
  const newTemplate: SoulTemplate = {
    id: randomUUID(),
    name: request.name,
    content: request.content,
    category: request.category,
    description: request.description
  }
  templates.push(newTemplate)
  storeSet(TEMPLATES_KEY, templates)
  return newTemplate
}

/** Update an existing template */
export async function updateTemplate(request: { id: string; name?: string; content?: string; category?: string; description?: string }): Promise<SoulTemplate> {
  const templates = getTemplates()
  const index = templates.findIndex(t => t.id === request.id)
  if (index === -1) {
    throw new Error(`Template not found: ${request.id}`)
  }
  const updated: SoulTemplate = {
    ...templates[index],
    ...request
  }
  templates[index] = updated
  storeSet(TEMPLATES_KEY, templates)
  return updated
}

/** Delete a template by id */
export async function deleteTemplate(id: string): Promise<void> {
  const templates = getTemplates()
  const filtered = templates.filter(t => t.id !== id)
  storeSet(TEMPLATES_KEY, filtered)
}
