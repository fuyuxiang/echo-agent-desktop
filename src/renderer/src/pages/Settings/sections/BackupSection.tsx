import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useBackupStore } from '@/stores/backupStore'
import styles from '../settings.module.scss'

export function BackupSection(): React.JSX.Element {
  const { t } = useTranslation()
  const {
    backups,
    loading,
    error,
    fetchBackups,
    createBackup,
    restoreBackup,
    deleteBackup
  } = useBackupStore()

  useEffect(() => {
    fetchBackups()
  }, [fetchBackups])

  const handleCreate = async (): Promise<void> => {
    const name = prompt(t('settings.backupName'))
    if (name) {
      await createBackup({ name })
    }
  }

  const handleRestore = async (id: string): Promise<void> => {
    if (confirm(t('settings.confirmRestore'))) {
      await restoreBackup({ id })
    }
  }

  return (
    <div className={styles.section}>
      <h2>{t('settings.backup')}</h2>
      {error && <div className={styles.error}>{error}</div>}
      <div className={styles.backupActions}>
        <button onClick={handleCreate} className={styles.addButton}>
          {t('settings.createBackup')}
        </button>
      </div>
      {loading ? (
        <div className={styles.loading}>{t('settings.loading')}</div>
      ) : (
        <div className={styles.backupList}>
          {backups.length === 0 ? (
            <div className={styles.empty}>{t('settings.noBackups')}</div>
          ) : (
            backups.map((backup) => (
              <div key={backup.id} className={styles.backupItem}>
                <div className={styles.backupInfo}>
                  <h3>{backup.name}</h3>
                  <p>{new Date(backup.createdAt).toLocaleString()}</p>
                  {backup.description && <p>{backup.description}</p>}
                </div>
                <div className={styles.backupActions}>
                  <button
                    onClick={() => handleRestore(backup.id)}
                    className={styles.restoreButton}
                  >
                    {t('settings.restore')}
                  </button>
                  <button
                    onClick={() => deleteBackup(backup.id)}
                    className={styles.removeButton}
                  >
                    {t('settings.remove')}
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}
