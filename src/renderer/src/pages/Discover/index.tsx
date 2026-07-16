import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSkillStore } from '@/stores/skillStore'
import type { SkillConfig } from '@shared/skill-types'
import SkillList from './SkillList'
import SkillDetail from './SkillDetail'
import styles from './discover.module.scss'

export default function DiscoverPage(): React.JSX.Element {
  const { t } = useTranslation()
  const {
    skills,
    categories,
    loading,
    error,
    fetchSkills,
    installSkill,
    uninstallSkill
  } = useSkillStore()

  const [selectedSkill, setSelectedSkill] = useState<SkillConfig | null>(null)
  const [filterCategory, setFilterCategory] = useState<string>('all')

  useEffect(() => {
    fetchSkills()
  }, [fetchSkills])

  const handleInstall = async (skillId: string): Promise<void> => {
    await installSkill({ skillId })
  }

  const handleUninstall = async (skillId: string): Promise<void> => {
    await uninstallSkill({ skillId })
  }

  const handleSelectSkill = (skill: SkillConfig): void => {
    setSelectedSkill(skill)
  }

  const handleBack = (): void => {
    setSelectedSkill(null)
  }

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
              <option key={category.id} value={category.id}>
                {category.name} ({category.skillCount})
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
