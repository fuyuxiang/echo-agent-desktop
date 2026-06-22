import { useTranslation } from 'react-i18next'
import styles from './skill-deps-dialog.module.scss'

interface SkillDepsDialogProps {
  skillName: string
  missing: string[]
  installing: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function SkillDepsDialog({
  skillName,
  missing,
  installing,
  onConfirm,
  onCancel
}: SkillDepsDialogProps): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div
      className={styles.overlay}
      role="dialog"
      aria-modal="true"
      aria-label={t('skill.deps.title')}
    >
      <div className={styles.dialog}>
        <h3 className={styles.title}>{t('skill.deps.title')}</h3>
        <p className={styles.prompt}>{t('skill.deps.prompt', { name: skillName })}</p>
        <ul className={styles.pkgList}>
          {missing.map((p) => (
            <li key={p} className={styles.pkg}>
              {p}
            </li>
          ))}
        </ul>
        <p className={styles.source}>{t('skill.deps.source')}</p>
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.cancelBtn}
            disabled={installing}
            onClick={onCancel}
          >
            {t('skill.deps.cancel')}
          </button>
          <button
            type="button"
            className={styles.installBtn}
            disabled={installing}
            onClick={onConfirm}
          >
            {installing ? t('skill.deps.installing') : t('skill.deps.install')}
          </button>
        </div>
      </div>
    </div>
  )
}
