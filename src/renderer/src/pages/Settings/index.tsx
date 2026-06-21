import { useState } from 'react'
import { GeneralSection } from './sections/GeneralSection'
import { ModelSection } from './sections/ModelSection'
import { ConnectionSection } from './sections/ConnectionSection'
import { MemorySection } from './sections/MemorySection'
import { EnvironmentSection } from './sections/EnvironmentSection'
import { AboutSection } from './sections/AboutSection'
import MemoryPage from '@/pages/Memory'
import SkillsPage from '@/pages/Skills'
import styles from './settings.module.scss'

type Section =
  | 'general'
  | 'model'
  | 'connection'
  | 'memory'
  | 'memoryStore'
  | 'skills'
  | 'environment'
  | 'about'

const SECTIONS: { key: Section; label: string }[] = [
  { key: 'general', label: '通用' },
  { key: 'model', label: '模型配置' },
  { key: 'connection', label: '连接' },
  { key: 'skills', label: '技能库' },
  { key: 'memoryStore', label: '记忆区' },
  { key: 'memory', label: '记忆管理' },
  { key: 'environment', label: 'Python 环境' },
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
      case 'connection':
        return <ConnectionSection />
      case 'skills':
        return <SkillsPage />
      case 'memoryStore':
        return <MemoryPage />
      case 'memory':
        return <MemorySection />
      case 'environment':
        return <EnvironmentSection />
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
