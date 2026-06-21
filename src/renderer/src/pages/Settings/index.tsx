import { useState } from 'react'
import { GeneralSection } from './sections/GeneralSection'
import { ModelSection } from './sections/ModelSection'
import { ConnectionSection } from './sections/ConnectionSection'
import { MemorySection } from './sections/MemorySection'
import { EnvironmentSection } from './sections/EnvironmentSection'
import { AboutSection } from './sections/AboutSection'
import styles from './settings.module.scss'

type Section = 'general' | 'model' | 'connection' | 'memory' | 'environment' | 'about'

const SECTIONS: { key: Section; label: string }[] = [
  { key: 'general', label: '通用' },
  { key: 'model', label: '模型配置' },
  { key: 'connection', label: '连接' },
  { key: 'memory', label: '记忆管理' },
  { key: 'environment', label: 'Python 环境' },
  { key: 'about', label: '关于' }
]

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
      case 'memory':
        return <MemorySection />
      case 'environment':
        return <EnvironmentSection />
      case 'about':
        return <AboutSection />
    }
  }

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
      <div className={styles.content}>{renderSection()}</div>
    </div>
  )
}
