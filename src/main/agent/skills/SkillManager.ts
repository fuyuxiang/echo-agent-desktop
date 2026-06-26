// src/main/agent/skills/SkillManager.ts
import type { SkillModule, SkillManifest } from './types'
import type { Tool } from '../tools/base'
import type { SkillGateway } from '../tools/skill-facade'

export class SkillManager implements SkillGateway {
  private modules = new Map<string, SkillModule>()
  private activeByChat = new Map<string, Set<string>>()

  constructor(modules: SkillModule[]) {
    for (const m of modules) this.modules.set(m.manifest.id, m)
  }

  list(): SkillManifest[] {
    return [...this.modules.values()].map((m) => m.manifest)
  }

  activate(chatId: string, skillId: string): void {
    if (!this.modules.has(skillId)) return
    const set = this.activeByChat.get(chatId) ?? new Set<string>()
    set.add(skillId)
    this.activeByChat.set(chatId, set)
  }

  deactivate(chatId: string, skillId: string): void {
    this.activeByChat.get(chatId)?.delete(skillId)
  }

  activeIds(chatId: string): string[] {
    return [...(this.activeByChat.get(chatId) ?? [])]
  }

  activePromptFragments(chatId: string): string[] {
    return this.activeModules(chatId).map((m) => m.promptFragment).filter((s) => s.length > 0)
  }

  tools(chatId: string): Tool[] {
    return this.activeModules(chatId).flatMap((m) => m.tools)
  }

  private activeModules(chatId: string): SkillModule[] {
    return this.activeIds(chatId)
      .map((id) => this.modules.get(id))
      .filter((m): m is SkillModule => m !== undefined)
  }
}
