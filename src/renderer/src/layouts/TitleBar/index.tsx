import { useTranslation } from 'react-i18next'
import { useWindowMaximized } from '@/hooks'
import { appWindow } from '@/utils/window'
import { isMac } from '@/utils/platform'
import styles from './titlebar.module.scss'

/**
 * 自定义标题栏(双端适配)
 *
 * - mac: 系统红绿灯保留在左上角(主进程 hiddenInset),这里只渲染拖拽区 + 标题
 * - win: 完全自绘,右侧渲染 最小化/最大化/关闭 三键
 */
export function TitleBar(): React.JSX.Element {
  const { t } = useTranslation()
  const maximized = useWindowMaximized()

  return (
    <header className={styles.titlebar}>
      {/* mac 左侧给红绿灯留白 */}
      {isMac && <div className={styles.macTrafficLightSpace} />}

      <div className={styles.title}>{t('titlebar.appName')}</div>

      {/* win 自绘三键 */}
      {!isMac && (
        <div className={styles.winControls}>
          <button className={styles.winButton} title="最小化" onClick={() => appWindow.minimize()}>
            <svg width="10" height="10" viewBox="0 0 10 10">
              <line x1="0" y1="5" x2="10" y2="5" stroke="currentColor" strokeWidth="1" />
            </svg>
          </button>
          <button
            className={styles.winButton}
            title={maximized ? '还原' : '最大化'}
            onClick={() => appWindow.toggleMaximize()}
          >
            {maximized ? (
              <svg width="10" height="10" viewBox="0 0 10 10">
                <rect x="0" y="2.5" width="7" height="7" fill="none" stroke="currentColor" />
                <path d="M 2.5 2.5 V 0.5 H 9.5 V 7.5 H 7.5" fill="none" stroke="currentColor" />
              </svg>
            ) : (
              <svg width="10" height="10" viewBox="0 0 10 10">
                <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" />
              </svg>
            )}
          </button>
          <button
            className={`${styles.winButton} ${styles.winClose}`}
            title="关闭"
            onClick={() => appWindow.close()}
          >
            <svg width="10" height="10" viewBox="0 0 10 10">
              <line x1="0" y1="0" x2="10" y2="10" stroke="currentColor" strokeWidth="1" />
              <line x1="10" y1="0" x2="0" y2="10" stroke="currentColor" strokeWidth="1" />
            </svg>
          </button>
        </div>
      )}
    </header>
  )
}
