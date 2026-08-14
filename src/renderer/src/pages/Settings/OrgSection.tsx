import { useEffect, useState } from 'react'
import { useOrgStore, isOrgReady, isCacheStale } from '@/stores/orgStore'
import { toast } from '@/components/Toast'
import styles from './org-section.module.scss'

function fmtTime(ms: number | null): string {
  if (!ms) return '从未'
  return new Date(ms).toLocaleString()
}

/**
 * 企业接入设置。
 *
 * 这一页是员工使用组织知识库的唯一入口 —— 没有它,服务器上的文档对客户端
 * 而言不存在。
 */
export function OrgSection(): React.JSX.Element {
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

  useEffect(() => {
    if (status?.serverUrl) setServerInput(status.serverUrl)
  }, [status?.serverUrl])

  const ready = isOrgReady(status)

  const saveServer = async (): Promise<void> => {
    const url = serverInput.trim()
    if (url && !/^https?:\/\//.test(url)) {
      toast.error('地址需以 http:// 或 https:// 开头')
      return
    }
    // 换服务器会清掉凭证与缓存,这一点必须提前告知而不是事后发现。
    if (status?.loggedIn && url !== status.serverUrl) {
      if (!window.confirm('更换服务器会清除当前登录状态与本地缓存,继续?')) return
    }
    await setServer(url)
    setEditingServer(false)
    toast.success(url ? '已保存服务器地址' : '已清除服务器配置')
  }

  const doLogin = async (): Promise<void> => {
    if (!username.trim() || !password) {
      toast.error('请填写用户名和密码')
      return
    }
    const res = await login(username.trim(), password)
    if (res.ok) {
      setPassword('')
      toast.success('已接入企业知识库')
    } else {
      toast.error(res.error ?? '登录失败')
    }
  }

  const doSync = async (): Promise<void> => {
    const res = await sync()
    if (res.ok) toast.success('同步完成')
    else toast.error(res.error ?? '同步失败')
  }

  return (
    <section className={styles.wrap}>
      <h3 className={styles.title}>企业知识库</h3>
      <p className={styles.desc}>
        接入后,问答会默认基于公司文档回答并给出引用;你也可以把工作中的结论沉淀回组织知识库。
      </p>

      {/* 服务器地址 */}
      <div className={styles.row}>
        <span className={styles.rowLabel}>服务器地址</span>
        {editingServer || !status?.configured ? (
          <div className={styles.inline}>
            <input
              className={styles.input}
              placeholder="https://echo.company.internal"
              value={serverInput}
              onChange={(e) => setServerInput(e.target.value)}
            />
            <button type="button" className={styles.primary} onClick={() => void saveServer()}>
              保存
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
                取消
              </button>
            )}
          </div>
        ) : (
          <div className={styles.inline}>
            <code className={styles.code}>{status.serverUrl}</code>
            <button type="button" className={styles.linkBtn} onClick={() => setEditingServer(true)}>
              修改
            </button>
          </div>
        )}
      </div>

      {/* 登录状态 */}
      {status?.configured && (
        <div className={styles.row}>
          <span className={styles.rowLabel}>登录状态</span>
          {ready ? (
            <div className={styles.inline}>
              <span className={styles.dotOk} />
              <span>
                {status.user?.displayName ?? '已登录'}
                {status.user?.groups?.length
                  ? `（${status.user.groups.map((g) => g.name).join('、')}）`
                  : ''}
              </span>
              <button type="button" className={styles.linkBtn} onClick={() => void logout()}>
                退出
              </button>
            </div>
          ) : (
            <div className={styles.loginForm}>
              <input
                className={styles.input}
                placeholder="用户名"
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
              <input
                className={styles.input}
                type="password"
                placeholder="密码"
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
                {loggingIn ? '登录中…' : '登录'}
              </button>
            </div>
          )}
        </div>
      )}

      {/* 同步状态 */}
      {ready && status && (
        <>
          <div className={styles.row}>
            <span className={styles.rowLabel}>服务器</span>
            <div className={styles.inline}>
              {status.reachable === false ? (
                <>
                  <span className={styles.dotWarn} />
                  <span>不可达,当前使用本地缓存</span>
                </>
              ) : (
                <>
                  <span className={styles.dotOk} />
                  <span>正常</span>
                </>
              )}
            </div>
          </div>

          <div className={styles.row}>
            <span className={styles.rowLabel}>离线缓存</span>
            <div className={styles.inline}>
              <span>
                {status.cachedDocs} 份文档 / {status.cachedChunks} 个片段
              </span>
              <span className={isCacheStale(status) ? styles.staleText : styles.muted}>
                最后同步:{fmtTime(status.lastSyncAt)}
              </span>
              <button
                type="button"
                className={styles.ghost}
                disabled={syncing}
                onClick={() => void doSync()}
              >
                {syncing ? '同步中…' : '立即同步'}
              </button>
            </div>
          </div>

          <p className={styles.note}>
            缓存用于断网时兜底,只读。你的个人数据与本机文件不会上传。
          </p>
        </>
      )}
    </section>
  )
}
