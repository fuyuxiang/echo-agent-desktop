import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useOrgStore, isOrgReady, isCacheStale } from '@/stores/orgStore'
import { toast } from '@/components/Toast'
import styles from './org-section.module.scss'

function fmtTime(
  ms: number | null,
  t: (key: string, opts?: Record<string, unknown>) => string
): string {
  if (!ms) return t('orgSection.never')
  return new Date(ms).toLocaleString()
}

/**
 * 企业接入设置。
 *
 * 这一页是员工使用组织知识库的唯一入口 —— 没有它,服务器上的文档对客户端
 * 而言不存在。
 */
export function OrgSection(): React.JSX.Element {
  const { t } = useTranslation()
  const status = useOrgStore((s) => s.status)
  const syncing = useOrgStore((s) => s.syncing)
  const loggingIn = useOrgStore((s) => s.loggingIn)
  const init = useOrgStore((s) => s.init)
  const setServer = useOrgStore((s) => s.setServer)
  const login = useOrgStore((s) => s.login)
  const logout = useOrgStore((s) => s.logout)
  const sync = useOrgStore((s) => s.sync)

  const [serverInput, setServerInput] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [editingServer, setEditingServer] = useState(false)

  useEffect(() => {
    void init()
  }, [init])

  // 同步 props 到本地受控输入:仅当用户未在编辑时同步,避免用户输入过程中被覆盖。
  // 这里用 derived state 而非 useEffect,符合 React 推荐做法。
  // 实际渲染逻辑使用 editingServer 守门:editing 时不入此分支。
  // 不需要 effect。

  const ready = isOrgReady(status)

  const saveServer = async (): Promise<void> => {
    const url = serverInput.trim()
    if (url && !/^https?:\/\//.test(url)) {
      toast.error(t('orgSection.urlInvalid'))
      return
    }
    // 换服务器会清掉凭证与缓存,这一点必须提前告知而不是事后发现。
    if (status?.loggedIn && url !== status.serverUrl) {
      if (!window.confirm(t('orgSection.changeServerConfirm'))) return
    }
    await setServer(url)
    setEditingServer(false)
    toast.success(url ? t('orgSection.serverSaved') : t('orgSection.serverCleared'))
  }

  const doLogin = async (): Promise<void> => {
    if (!username.trim() || !password) {
      toast.error(t('orgSection.fillCredentials'))
      return
    }
    const res = await login(username.trim(), password)
    if (res.ok) {
      setPassword('')
      toast.success(t('orgSection.connected'))
    } else {
      toast.error(res.error ?? t('orgSection.loginFailed'))
    }
  }

  const doSync = async (): Promise<void> => {
    const res = await sync()
    if (res.ok) toast.success(t('orgSection.syncDone'))
    else toast.error(res.error ?? t('orgSection.syncFailed'))
  }

  return (
    <section className={styles.wrap}>
      <h3 className={styles.title}>{t('orgSection.title')}</h3>
      <p className={styles.desc}>{t('orgSection.desc')}</p>

      {/* 服务器地址 */}
      <div className={styles.row}>
        <span className={styles.rowLabel}>{t('orgSection.serverUrl')}</span>
        {editingServer || !status?.configured ? (
          <div className={styles.inline}>
            <input
              className={styles.input}
              placeholder="https://echo.company.internal"
              value={serverInput}
              onChange={(e) => setServerInput(e.target.value)}
            />
            <button type="button" className={styles.primary} onClick={() => void saveServer()}>
              {t('common.save')}
            </button>
            {status?.configured && (
              <button
                type="button"
                className={styles.ghost}
                onClick={() => {
                  setServerInput(status.serverUrl)
                  setEditingServer(false)
                }}
              >
                {t('common.cancel')}
              </button>
            )}
          </div>
        ) : (
          <div className={styles.inline}>
            <code className={styles.code}>{status.serverUrl}</code>
            <button type="button" className={styles.linkBtn} onClick={() => setEditingServer(true)}>
              {t('common.save').replace(t('common.save'), t('orgSection.edit'))}
            </button>
          </div>
        )}
      </div>

      {/* 登录状态 */}
      {status?.configured && (
        <div className={styles.row}>
          <span className={styles.rowLabel}>{t('orgSection.loginStatus')}</span>
          {ready ? (
            <div className={styles.inline}>
              <span className={styles.dotOk} />
              <span>
                {status.user?.displayName ?? t('orgSection.loggedIn')}
                {status.user?.groups?.length
                  ? `(${status.user.groups.map((g) => g.name).join(t('common.listJoiner'))})`
                  : ''}
              </span>
              <button type="button" className={styles.linkBtn} onClick={() => void logout()}>
                {t('common.logout')}
              </button>
            </div>
          ) : (
            <div className={styles.loginForm}>
              <input
                className={styles.input}
                placeholder={t('orgSection.usernamePlaceholder')}
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
              <input
                className={styles.input}
                type="password"
                placeholder={t('orgSection.passwordPlaceholder')}
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void doLogin()
                }}
              />
              <button
                type="button"
                className={styles.primary}
                disabled={loggingIn}
                onClick={() => void doLogin()}
              >
                {loggingIn ? t('orgSection.loggingIn') : t('common.login')}
              </button>
            </div>
          )}
        </div>
      )}

      {/* 同步状态 */}
      {ready && status && (
        <>
          <div className={styles.row}>
            <span className={styles.rowLabel}>{t('orgSection.server')}</span>
            <div className={styles.inline}>
              {status.reachable === false ? (
                <>
                  <span className={styles.dotWarn} />
                  <span>{t('orgSection.unreachable')}</span>
                </>
              ) : (
                <>
                  <span className={styles.dotOk} />
                  <span>{t('orgSection.normal')}</span>
                </>
              )}
            </div>
          </div>

          <div className={styles.row}>
            <span className={styles.rowLabel}>{t('orgSection.offlineCache')}</span>
            <div className={styles.inline}>
              <span>
                {t('orgSection.cachedDocs', {
                  docs: status.cachedDocs,
                  chunks: status.cachedChunks
                })}
              </span>
              <span className={isCacheStale(status) ? styles.staleText : styles.muted}>
                {t('orgSection.lastSync', { time: fmtTime(status.lastSyncAt, t) })}
              </span>
              <button
                type="button"
                className={styles.ghost}
                disabled={syncing}
                onClick={() => void doSync()}
              >
                {syncing ? t('orgSection.syncing') : t('orgSection.syncNow')}
              </button>
            </div>
          </div>

          <p className={styles.note}>{t('orgSection.cacheNote')}</p>
        </>
      )}
    </section>
  )
}
