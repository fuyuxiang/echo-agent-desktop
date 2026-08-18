import { useTranslation } from 'react-i18next'
import { useAppStore } from '@/stores/appStore'
import type { AppSettings } from '@shared/types'

export function GeneralSection(): React.JSX.Element {
  const { t } = useTranslation()
  const { settings, setTheme, setLanguage, setLaunchAtLogin } = useAppStore()

  const handleLaunchAtLogin = (checked: boolean): void => {
    setLaunchAtLogin(checked)
    window.api.permission.setLoginItem(checked)
  }

  return (
    <div>
      <h2 style={{ marginBottom: 24 }}>{t('settings.general.title')}</h2>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>{t('settings.general.theme')}</span>
          <select
            value={settings.theme}
            onChange={(e) => setTheme(e.target.value as AppSettings['theme'])}
            style={{ padding: '4px 8px' }}
          >
            <option value="system">{t('settings.general.themeSystem')}</option>
            <option value="light">{t('settings.general.themeLight')}</option>
            <option value="dark">{t('settings.general.themeDark')}</option>
          </select>
        </label>
        <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>{t('settings.general.language')}</span>
          <select
            value={settings.language}
            onChange={(e) => setLanguage(e.target.value as AppSettings['language'])}
            style={{ padding: '4px 8px' }}
          >
            <option value="zh-CN">中文</option>
            <option value="en-US">English</option>
          </select>
        </label>
        <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>{t('settings.general.launchAtLogin')}</span>
          <input
            type="checkbox"
            checked={settings.launchAtLogin}
            onChange={(e) => handleLaunchAtLogin(e.target.checked)}
          />
        </label>
      </div>
    </div>
  )
}
