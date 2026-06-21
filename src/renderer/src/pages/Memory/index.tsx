import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useRequest } from 'ahooks'
import clsx from 'clsx'
import {
  listPersonalMemory,
  searchPersonalMemory,
  deletePersonalMemory
} from '@/services/agent-memory'
import { listProjectMemory } from '@/services/server'
import styles from './memory.module.scss'

type Tab = 'personal' | 'project'

/** 记忆视图：个人记忆(本地 echo-agent,可搜索/删除) + 项目记忆(服务器,只读) 双 Tab */
export default function MemoryPage(): React.JSX.Element {
  const { t } = useTranslation()
  const [tab, setTab] = useState<Tab>('personal')
  const [query, setQuery] = useState('')

  // 个人记忆: 有查询走语义检索, 否则列全部
  const personal = useRequest(
    () => (query.trim() ? searchPersonalMemory(query.trim()) : listPersonalMemory()),
    { ready: tab === 'personal', refreshDeps: [tab] }
  )
  const project = useRequest(() => listProjectMemory(), {
    ready: tab === 'project',
    refreshDeps: [tab]
  })

  const current = tab === 'personal' ? personal : project
  const list = (tab === 'personal' ? personal.data : project.data) ?? []

  const handleSearch = (): void => {
    personal.refresh()
  }

  const handleDelete = async (id: string): Promise<void> => {
    await deletePersonalMemory(id)
    personal.refresh()
  }

  return (
    <div className={styles.page}>
      <div className={styles.main}>
        <div className={styles.pageHeader}>
          <span>Memory</span>
          <strong>{t('memory.title')}</strong>
        </div>

        <div className={styles.tabs} role="tablist">
          <button
            role="tab"
            className={clsx(styles.tab, tab === 'personal' && styles.active)}
            aria-selected={tab === 'personal'}
            onClick={() => setTab('personal')}
          >
            {t('memory.personal')}
          </button>
          <button
            role="tab"
            className={clsx(styles.tab, tab === 'project' && styles.active)}
            aria-selected={tab === 'project'}
            onClick={() => setTab('project')}
          >
            {t('memory.project')}
          </button>
        </div>

        {tab === 'personal' && (
          <div className={styles.toolbar}>
            <input
              className={styles.search}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('memory.searchPlaceholder')}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            />
            <button className={styles.searchBtn} onClick={handleSearch}>
              {t('memory.search')}
            </button>
          </div>
        )}

        <div className={styles.list}>
          {current.loading && <div className={styles.empty}>{t('memory.loading')}</div>}
          {!current.loading && list.length === 0 && (
            <div className={styles.empty}>{t('memory.empty')}</div>
          )}
          {!current.loading &&
            list.map((m) => (
              <div key={m.id} className={styles.card}>
                <div className={styles.cardHeader}>
                  <p className={styles.content}>{m.content}</p>
                  {tab === 'personal' && (
                    <button className={styles.deleteBtn} onClick={() => handleDelete(m.id)}>
                      {t('memory.delete')}
                    </button>
                  )}
                </div>
                {m.tags?.length > 0 && (
                  <div className={styles.tags}>
                    {m.tags.map((tag) => (
                      <span key={tag} className={styles.tag}>
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
        </div>
      </div>
    </div>
  )
}
