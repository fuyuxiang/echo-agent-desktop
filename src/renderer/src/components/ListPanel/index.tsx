import styles from './list-panel.module.scss'

interface ListPanelProps {
  visible: boolean
  children: React.ReactNode
}

export function ListPanel({ visible, children }: ListPanelProps): React.JSX.Element | null {
  if (!visible) return null

  return <aside className={styles.panel}>{children}</aside>
}
