import { useAppStore } from '@/stores/appStore'
import type { AppSettings } from '@shared/types'

export function GeneralSection(): React.JSX.Element {
  const { settings, setTheme, setLanguage, setLaunchAtLogin } = useAppStore()

  const handleLaunchAtLogin = (checked: boolean): void => {
    setLaunchAtLogin(checked)
    window.api.permission.setLoginItem(checked)
  }

  return (
    <div>
      <h2 style={{ marginBottom: 24 }}>通用设置</h2>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>主题</span>
          <select
            value={settings.theme}
            onChange={(e) => setTheme(e.target.value as AppSettings['theme'])}
            style={{ padding: '4px 8px' }}
          >
            <option value="system">跟随系统</option>
            <option value="light">浅色</option>
            <option value="dark">深色</option>
          </select>
        </label>
        <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>语言</span>
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
          <span>开机自启</span>
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
