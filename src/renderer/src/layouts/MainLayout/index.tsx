import { Outlet } from 'react-router-dom'
import { TitleBar } from '@/layouts/TitleBar'
import styles from './layout.module.scss'

/**
 * 主布局:自定义标题栏 + 页面内容区
 * 所有业务页面都渲染在 <Outlet /> 中
 */
export function MainLayout(): React.JSX.Element {
  return (
    <div className={styles.layout}>
      <TitleBar />
      <main className={styles.content}>
        <Outlet />
      </main>
    </div>
  )
}
