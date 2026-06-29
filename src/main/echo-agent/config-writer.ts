import { parse, stringify } from 'yaml'
import { dirname } from 'node:path'
import { configPath } from './paths'

export interface ModelConfigInput {
  baseUrl: string
  apiKey: string
  model: string
}

export function mergeModelsBlock(yamlText: string, cfg: ModelConfigInput): string {
  const doc = (yamlText.trim() ? parse(yamlText) : {}) as Record<string, unknown>
  doc.models = {
    default_model: cfg.model,
    providers: [
      { name: 'desktop', apiKey: cfg.apiKey, apiBase: cfg.baseUrl, models: [cfg.model] }
    ]
  }
  return stringify(doc)
}

export interface ConfigWriterDeps {
  readFile: (p: string) => string
  writeFile: (p: string, data: string) => void
  ensureDir: (p: string) => void
  homeDir: string
}

export function writeModelConfig(deps: ConfigWriterDeps, cfg: ModelConfigInput): void {
  const target = configPath(deps.homeDir)
  let existing = ''
  try {
    existing = deps.readFile(target)
  } catch {
    existing = '' // missing file → treat as empty
  }
  const merged = mergeModelsBlock(existing, cfg)
  deps.ensureDir(dirname(target))
  deps.writeFile(target, merged)
}
