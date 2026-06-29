import { parse, stringify } from 'yaml'

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
