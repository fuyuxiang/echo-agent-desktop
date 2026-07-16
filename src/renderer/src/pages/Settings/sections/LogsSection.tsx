import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useLogsStore } from '@/stores/logsStore'
import styles from '../settings.module.scss'

export function LogsSection(): React.JSX.Element {
  const { t } = useTranslation()
  const {
    logs,
    loading,
    error,
    fetchLogs,
    clearLogs
  } = useLogsStore()

  useEffect(() => {
    fetchLogs()
  }, [fetchLogs])

  const getLevelClass = (level: string): string => {
    switch (level) {
      case 'error':
        return styles.errorLevel
      case 'warn':
        return styles.warnLevel
      case 'info':
        return styles.infoLevel
      case 'debug':
        return styles.debugLevel
      default:
        return ''
    }
  }

  return (
    <div className={styles.section}>
      <h2>{t('settings.logs')}</h2>
      {error && <div className={styles.error}>{error}</div>}
      <div className={styles.logActions}>
        <button onClick={clearLogs} className={styles.clearButton}>
          {t('settings.clearLogs')}
        </button>
        <button onClick={fetchLogs} className={styles.refreshButton}>
          {t('settings.refresh')}
        </button>
      </div>
      {loading ? (
        <div className={styles.loading}>{t('settings.loading')}</div>
      ) : (
        <div className={styles.logList}>
          {logs.length === 0 ? (
            <div className={styles.empty}>{t('settings.noLogs')}</div>
          ) : (
            logs.map((log) => (
              <div
                key={log.id}
                className={`${styles.logItem} ${getLevelClass(log.level)}`}
              >
                <div className={styles.logHeader}>
                  <span className={styles.logLevel}>{log.level.toUpperCase()}</span>
                  <span className={styles.logTime}>
                    {new Date(log.timestamp).toLocaleString()}
                  </span>
                </div>
                <div className={styles.logMessage}>{log.message}</div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}
