import { useTranslation } from 'react-i18next'
import type { SkillConfig } from '@shared/skill-types'
import styles from './discover.module.scss'

interface SkillDetailProps {
  skill: SkillConfig
  onBack: () => void
  onInstall: (skillId: string) => void
  onUninstall: (skillId: string) => void
}

export default function SkillDetail({
  skill,
  onBack,
  onInstall,
  onUninstall
}: SkillDetailProps): React.JSX.Element {
  const { t } = useTranslation()

  return (
    <div className={styles.skillDetail}>
      <button onClick={onBack} className={styles.backButton}>
        {t('discover.back')}
      </button>
      <div className={styles.detailHeader}>
        <h2>{skill.name}</h2>
        <span className={styles.version}>v{skill.version}</span>
      </div>
      <div className={styles.detailMeta}>
        <span className={styles.author}>
          {t('discover.author')}: {skill.author}
        </span>
        <span className={styles.category}>
          {t('discover.category')}: {skill.category}
        </span>
        <span className={styles.status}>
          {skill.isInstalled ? t('discover.installed') : t('discover.notInstalled')}
        </span>
      </div>
      <div className={styles.detailDescription}>
        <h3>{t('discover.description')}</h3>
        <p>{skill.description}</p>
      </div>
      <div className={styles.detailActions}>
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
  )
}
