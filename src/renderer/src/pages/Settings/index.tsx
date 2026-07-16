import { useState } from 'react'
import { GeneralSection } from './sections/GeneralSection'
import { ModelSection } from './sections/ModelSection'
import { LocalModelSection } from './sections/LocalModelSection'
import { ProviderSection } from './sections/ProviderSection'
import { BackupSection } from './sections/BackupSection'
import { LogsSection } from './sections/LogsSection'
import { NetworkSection } from './sections/NetworkSection'
import { ThemeSection } from './sections/ThemeSection'
import { AboutSection } from './sections/AboutSection'
import MemoryPage from '@/pages/Memory'
import SkillsPage from '@/pages/Skills'
import styles from './settings.module.scss'

type Section =
  | 'general'
  | 'model'
  | 'localModel'
  | 'providers'
  | 'backup'
  | 'logs'
  | 'network'
  | 'theme'
  | 'memoryStore'
  | 'skills'
  | 'about'

const SECTIONS: { key: Section; label: string }[] = [
  { key: 'general', label: '通用' },
  { key: 'model', label: '模型配置' },
  { key: 'localModel', label: '本地模型' },
  { key: 'providers', label: '提供商' },
  { key: 'backup', label: '备份' },
  { key: 'logs', label: '日志' },
  { key: 'network', label: '网络' },
  { key: 'theme', label: '主题' },
  { key: 'skills', label: '技能库' },
  { key: 'memoryStore', label: '记忆' },
  { key: 'about', label: '关于' }
]

// 这些分区直接渲染整页组件,需占满内容区且不被 .content 的全局样式覆盖
const FULL_BLEED: Section[] = ['memoryStore', 'skills']

export default function SettingsPage(): React.JSX.Element {
  const [active, setActive] = useState<Section>('general')

  const renderSection = (): React.JSX.Element => {
    switch (active) {
      case 'general':
        return <GeneralSection />
      case 'model':
        return <ModelSection />
      case 'localModel':
        return <LocalModelSection />
      case 'providers':
        return <ProviderSection />
      case 'backup':
        return <BackupSection />
      case 'logs':
        return <LogsSection />
      case 'network':
        return <NetworkSection />
      case 'theme':
        return <ThemeSection />
      case 'skills':
        return <SkillsPage />
      case 'memoryStore':
        return <MemoryPage />
      case 'about':
        return <AboutSection />
    }
  }

  const isFullBleed = FULL_BLEED.includes(active)

  return (
    <div className={styles.page}>
      <nav className={styles.nav}>
        {SECTIONS.map((s) => (
          <button
            key={s.key}
            className={`${styles.navItem} ${active === s.key ? styles.active : ''}`}
            onClick={() => setActive(s.key)}
          >
            {s.label}
          </button>
        ))}
      </nav>
      <div className={isFullBleed ? styles.fullBleed : styles.content}>{renderSection()}</div>
    </div>
  )
}
