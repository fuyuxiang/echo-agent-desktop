import { useEffect } from 'react'
import { useAppStore } from '@/stores/appStore'

/**
 * 主题 hook(App.tsx 调用一次)
 *
 * - 将 appStore 的 theme 同步到 html[data-theme]
 * - theme = 'system' 时跟随系统深浅色(matchMedia 监听实时切换)
 */
export function useTheme(): void {
  const theme = useAppStore((s) => s.settings.theme)

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')

    const apply = (): void => {
      const resolved = theme === 'system' ? (media.matches ? 'dark' : 'light') : theme
      document.documentElement.setAttribute('data-theme', resolved)
    }

    apply()
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [theme])
}
