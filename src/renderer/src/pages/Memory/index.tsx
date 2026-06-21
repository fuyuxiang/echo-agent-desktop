import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useRequest } from 'ahooks'
import clsx from 'clsx'
import { listPersonalMemory } from '@/services/agent-memory'
import { listProjectMemory } from '@/services/server'
import styles from './memory.module.scss'

type Tab = 'personal' | 'project'

/** 记忆区视图：个人记忆(本地 echo-agent) + 项目记忆(服务器) 双 Tab */
export default function MemoryPage(): React.JSX.Element {
  const { t } = useTranslation()
  const [tab, setTab] = useState<Tab>('personal')

  const personal = useRequest(listPersonalMemory, {
    ready: tab === 'personal',
    refreshDeps: [tab]
  })
  const project = useRequest(() => listProjectMemory(), {
    ready: tab === 'project',
    refreshDeps: [tab]
  })

  const current = tab === 'personal' ? personal : project
  const list = (tab === 'personal' ? personal.data : project.data) ?? []

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

        <div className={styles.list}>
          {current.loading && <div className={styles.empty}>{t('memory.loading')}</div>}
          {!current.loading && list.length === 0 && (
            <div className={styles.empty}>{t('memory.empty')}</div>
          )}
          {!current.loading &&
            list.map((m) => (
              <div key={m.id} className={styles.card}>
                <p className={styles.content}>{m.content}</p>
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
