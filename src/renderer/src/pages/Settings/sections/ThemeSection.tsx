import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSettingsStore } from '@/stores/settingsStore'
import type { ThemeMode } from '@shared/settings-types'
import styles from '../settings.module.scss'

export function ThemeSection(): React.JSX.Element {
  const { t } = useTranslation()
  const { settings, updateSettings } = useSettingsStore()

  const [theme, setTheme] = useState<ThemeMode>(settings?.theme || 'system')

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (settings) {
      await updateSettings({
        theme
      })
    }
  }

  return (
    <div className={styles.section}>
      <h2>{t('settings.theme')}</h2>
      <form onSubmit={handleSubmit} className={styles.form}>
        <div className={styles.field}>
          <label>{t('settings.themeMode')}</label>
          <div className={styles.themeOptions}>
            <label className={styles.themeOption}>
              <input
                type="radio"
                name="theme"
                value="light"
                checked={theme === 'light'}
                onChange={(e) => setTheme(e.target.value as ThemeMode)}
              />
              <span>{t('settings.light')}</span>
            </label>
            <label className={styles.themeOption}>
              <input
                type="radio"
                name="theme"
                value="dark"
                checked={theme === 'dark'}
                onChange={(e) => setTheme(e.target.value as ThemeMode)}
              />
              <span>{t('settings.dark')}</span>
            </label>
            <label className={styles.themeOption}>
              <input
                type="radio"
                name="theme"
                value="system"
                checked={theme === 'system'}
                onChange={(e) => setTheme(e.target.value as ThemeMode)}
              />
              <span>{t('settings.system')}</span>
            </label>
          </div>
        </div>
        <button type="submit" className={styles.saveButton}>
          {t('settings.save')}
        </button>
      </form>
    </div>
  )
}
