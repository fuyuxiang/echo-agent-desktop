import { useTranslation } from 'react-i18next'
import type { SkillConfig } from '@shared/skill-types'
import styles from './discover.module.scss'

interface SkillListProps {
  skills: SkillConfig[]
  onSelect: (skill: SkillConfig) => void
  onInstall: (skillId: string) => void
  onUninstall: (skillId: string) => void
}

export default function SkillList({
  skills,
  onSelect,
  onInstall,
  onUninstall
}: SkillListProps): React.JSX.Element {
  const { t } = useTranslation()

  if (skills.length === 0) {
    return <div className={styles.empty}>{t('discover.noSkills')}</div>
  }

  return (
    <div className={styles.skillGrid}>
      {skills.map((skill) => (
        <div key={skill.id} className={styles.skillCard}>
          <div className={styles.skillHeader}>
            <h3>{skill.name}</h3>
            <span className={styles.version}>v{skill.version}</span>
          </div>
          <p className={styles.description}>{skill.description}</p>
          <div className={styles.skillMeta}>
            <span className={styles.author}>{skill.author}</span>
            <span className={styles.category}>{skill.category}</span>
          </div>
          <div className={styles.skillActions}>
            <button
              onClick={() => onSelect(skill)}
              className={styles.viewButton}
            >
              {t('discover.view')}
            </button>
            {skill.isInstalled ? (
              <button
                onClick={() => onUninstall(skill.id)}
                className={styles.uninstallButton}
              >
                {t('discover.uninstall')}
              </button>
            ) : (
              <button
                onClick={() => onInstall(skill.id)}
                className={styles.installButton}
              >
                {t('discover.install')}
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}
