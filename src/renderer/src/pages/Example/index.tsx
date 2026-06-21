import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useRequest } from 'ahooks'
import type { ExampleRecord } from '@shared/types'
import { fetchGreeting, fetchExampleList } from '@/services/example'
import { toast } from '@/components/Toast'
import { useAppStore } from '@/stores/appStore'
import { db, logger, formatTime, clipboard } from '@/utils'
import i18n from '@/i18n'
import styles from './example.module.scss'

/**
 * Example 示例页(活模板)
 *
 * 演示基建全链路,新页面请依葫芦画瓢:
 * 1. 网络请求: services/example.ts + mock/example.ts(ahooks useRequest 管理 loading)
 * 2. 本地数据库: utils/db(渲染层 -> IPC -> better-sqlite3 DAO)
 * 3. KV 存储 + 主题/语言: stores/appStore(persist 自动落盘 electron-store)
 * 4. 全局提示: components/Toast
 * 5. 日志: utils/logger(自动汇入主进程日志文件)
 */
export default function ExamplePage(): React.JSX.Element {
  const { t } = useTranslation()
  const { settings, setTheme, setLanguage } = useAppStore()

  // ===== 1. 网络请求(手动触发) =====
  const {
    data: greeting,
    loading: greetingLoading,
    run: runGreeting
  } = useRequest(fetchGreeting, { manual: true })

  // ===== 2. 列表请求(自动加载) =====
  const { data: list = [], loading: listLoading } = useRequest(() => fetchExampleList())

  // ===== 3. 本地数据库 =====
  const [dbInput, setDbInput] = useState('')
  const { data: records = [], refresh: refreshRecords } = useRequest<ExampleRecord[], []>(() =>
    db.example.list()
  )

  const handleAddRecord = async (): Promise<void> => {
    const content = dbInput.trim()
    if (!content) return
    await db.example.add(content)
    logger.info('[example] 数据库写入:', content)
    setDbInput('')
    refreshRecords()
  }

  const handleClearRecords = async (): Promise<void> => {
    await db.example.clear()
    refreshRecords()
    toast.info(t('common.delete'))
  }

  // ===== 4. 主题 / 语言切换 =====
  const toggleTheme = (): void => {
    const next = settings.theme === 'dark' ? 'light' : 'dark'
    setTheme(next)
  }

  const toggleLanguage = (): void => {
    const next = settings.language === 'zh-CN' ? 'en-US' : 'zh-CN'
    setLanguage(next)
    i18n.changeLanguage(next)
  }

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>{t('example.title')}</h1>
      <p className={styles.description}>{t('example.description')}</p>

      {/* 1. 网络请求 + Mock */}
      <section className={styles.card}>
        <h2>{t('example.greetingTitle')}</h2>
        <div className={styles.row}>
          <button className={styles.button} disabled={greetingLoading} onClick={runGreeting}>
            {greetingLoading ? t('common.loading') : t('example.fetchGreeting')}
          </button>
          {greeting && (
            <span
              className={styles.greeting}
              title={formatTime(greeting.timestamp)}
              onClick={async () => {
                await clipboard.writeText(greeting.message)
                toast.success(t('common.copySuccess'))
              }}
            >
              {greeting.message}
            </span>
          )}
        </div>
      </section>

      {/* 2. 接口列表 */}
      <section className={styles.card}>
        <h2>{t('example.listTitle')}</h2>
        {listLoading ? (
          <p className={styles.muted}>{t('common.loading')}</p>
        ) : (
          <ul className={styles.list}>
            {list.map((item) => (
              <li key={item.id} className={styles.listItem}>
                <span className={item.done ? styles.done : ''}>{item.title}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 3. 本地数据库 */}
      <section className={styles.card}>
        <h2>{t('example.dbTitle')}</h2>
        <div className={styles.row}>
          <input
            className={styles.input}
            value={dbInput}
            placeholder={t('example.dbPlaceholder')}
            onChange={(e) => setDbInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleAddRecord()}
          />
          <button className={styles.buttonGhost} onClick={handleClearRecords}>
            {t('example.dbClear')}
          </button>
        </div>
        {records.length === 0 ? (
          <p className={styles.muted}>{t('example.noRecords')}</p>
        ) : (
          <ul className={styles.list}>
            {records.map((record) => (
              <li key={record.id} className={styles.listItem}>
                <span>{record.content}</span>
                <span className={styles.muted}>
                  {formatTime(record.createdAt, 'MM-DD HH:mm:ss')}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 4. KV 存储 + 主题/语言(persist 自动落盘) */}
      <section className={styles.card}>
        <h2>{t('example.storageTitle')}</h2>
        <div className={styles.row}>
          <button className={styles.button} onClick={toggleTheme}>
            {t('example.switchTheme')} ({settings.theme})
          </button>
          <button className={styles.button} onClick={toggleLanguage}>
            {t('example.switchLang')}
          </button>
        </div>
      </section>

      {/* 5. Toast */}
      <section className={styles.card}>
        <h2>{t('example.toastTitle')}</h2>
        <div className={styles.row}>
          <button className={styles.button} onClick={() => toast.success('Success!')}>
            {t('example.toastSuccess')}
          </button>
          <button className={styles.buttonGhost} onClick={() => toast.error('Something failed')}>
            {t('example.toastError')}
          </button>
        </div>
      </section>
    </div>
  )
}
