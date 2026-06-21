import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import zhCN from './locales/zh-CN.json'
import enUS from './locales/en-US.json'

/**
 * 多语言(i18next)
 *
 * - 默认中文,语言偏好持久化在 appStore(settings.language)
 * - 切换语言: useAppStore.getState().setLanguage('en-US') + i18n.changeLanguage('en-US')
 *   (App.tsx 中已做联动,业务只需改 store)
 * - 新增文案: 在 locales/zh-CN.json 与 en-US.json 同步添加 key
 */
i18n.use(initReactI18next).init({
  resources: {
    'zh-CN': { translation: zhCN },
    'en-US': { translation: enUS }
  },
  lng: 'zh-CN',
  fallbackLng: 'zh-CN',
  interpolation: {
    // React 自带 XSS 防护,无需二次转义
    escapeValue: false
  }
})

export default i18n
