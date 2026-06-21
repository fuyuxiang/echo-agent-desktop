import { Outlet } from 'react-router-dom'
import { TitleBar } from '@/layouts/TitleBar'
import { IconSidebar } from '@/components/IconSidebar'
import styles from './app-layout.module.scss'

export function AppLayout(): React.JSX.Element {
  return (
    <div className={styles.layout}>
      <TitleBar />
      <div className={styles.body}>
        <IconSidebar />
        <section className={styles.workspace}>
          <main className={styles.main}>
            <Outlet />
          </main>
        </section>
      </div>
    </div>
  )
}
