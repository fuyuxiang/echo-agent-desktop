import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSettingsStore } from '@/stores/settingsStore'
import styles from '../settings.module.scss'

export function NetworkSection(): React.JSX.Element {
  const { t } = useTranslation()
  const { settings, updateSettings } = useSettingsStore()

  const [formData, setFormData] = useState({
    proxy: settings?.network?.proxy || '',
    timeout: settings?.network?.timeout || 30000,
    retryCount: settings?.network?.retryCount || 3
  })

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (settings) {
      await updateSettings({
        network: formData
      })
    }
  }

  return (
    <div className={styles.section}>
      <h2>{t('settings.network')}</h2>
      <form onSubmit={handleSubmit} className={styles.form}>
        <div className={styles.field}>
          <label htmlFor="proxy">{t('settings.proxy')}</label>
          <input
            id="proxy"
            type="text"
            value={formData.proxy}
            onChange={(e) => setFormData({ ...formData, proxy: e.target.value })}
            placeholder={t('settings.proxyPlaceholder')}
          />
        </div>
        <div className={styles.field}>
          <label htmlFor="timeout">{t('settings.timeout')}</label>
          <input
            id="timeout"
            type="number"
            value={formData.timeout}
            onChange={(e) =>
              setFormData({ ...formData, timeout: parseInt(e.target.value) })
            }
            min={1000}
            max={300000}
          />
        </div>
        <div className={styles.field}>
          <label htmlFor="retryCount">{t('settings.retryCount')}</label>
          <input
            id="retryCount"
            type="number"
            value={formData.retryCount}
            onChange={(e) =>
              setFormData({ ...formData, retryCount: parseInt(e.target.value) })
            }
            min={0}
            max={10}
          />
        </div>
        <button type="submit" className={styles.saveButton}>
          {t('settings.save')}
        </button>
      </form>
    </div>
  )
}
