import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { skillsAPI, type Skill } from '@/services/agent/skills'
import type { SkillConfig } from '@shared/skill-types'
import SkillList from './SkillList'
import SkillDetail from './SkillDetail'
import styles from './discover.module.scss'

/**
 * Adapter: convert IPC Skill to SkillConfig expected by child components.
 * Fields not available from the IPC layer are filled with sensible defaults.
 */
function toSkillConfig(skill: Skill): SkillConfig {
  return {
    id: skill.id,
    name: skill.label,
    description: skill.description,
    version: '0.0.0',
    author: '',
    category: skill.kind,
    isInstalled: true,
    isActive: false,
    createdAt: '',
    updatedAt: ''
  }
}

export default function DiscoverPage(): React.JSX.Element {
  const { t } = useTranslation()

  const [skills, setSkills] = useState<SkillConfig[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedSkill, setSelectedSkill] = useState<SkillConfig | null>(null)
  const [filterCategory, setFilterCategory] = useState<string>('all')

  const loadSkills = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await skillsAPI.list()
      setSkills(result.skills.map(toSkillConfig))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadSkills()
  }, [loadSkills])

  const handleInstall = async (skillId: string): Promise<void> => {
    // IPC API does not provide installSkill; no-op for now
    console.warn('installSkill not supported by IPC API:', skillId)
  }

  const handleUninstall = async (skillId: string): Promise<void> => {
    // IPC API does not provide uninstallSkill; no-op for now
    console.warn('uninstallSkill not supported by IPC API:', skillId)
  }

  const handleSelectSkill = (skill: SkillConfig): void => {
    setSelectedSkill(skill)
  }

  const handleBack = (): void => {
    setSelectedSkill(null)
  }

  // Derive category list from loaded skills
  const categories = Array.from(new Set(skills.map((s) => s.category)))

  const filteredSkills =
    filterCategory === 'all'
      ? skills
      : skills.filter((skill) => skill.category === filterCategory)

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h1>{t('discover.title')}</h1>
        <div className={styles.filters}>
          <select
            value={filterCategory}
            onChange={(e) => setFilterCategory(e.target.value)}
            className={styles.filterSelect}
          >
            <option value="all">{t('discover.allCategories')}</option>
            {categories.map((category) => (
              <option key={category} value={category}>
                {category}
              </option>
            ))}
          </select>
        </div>
      </div>
      {error && <div className={styles.error}>{error}</div>}
      {loading ? (
        <div className={styles.loading}>{t('discover.loading')}</div>
      ) : selectedSkill ? (
        <SkillDetail
          skill={selectedSkill}
          onBack={handleBack}
          onInstall={handleInstall}
          onUninstall={handleUninstall}
        />
      ) : (
        <SkillList
          skills={filteredSkills}
          onSelect={handleSelectSkill}
          onInstall={handleInstall}
          onUninstall={handleUninstall}
        />
      )}
    </div>
  )
}
