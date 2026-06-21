import { KnowledgeSection } from '@/pages/Settings/sections/KnowledgeSection'
import styles from './knowledge.module.scss'

export default function KnowledgePage(): React.JSX.Element {
  return (
    <div className={styles.page}>
      <section className={styles.content}>
        <KnowledgeSection />
      </section>
    </div>
  )
}
