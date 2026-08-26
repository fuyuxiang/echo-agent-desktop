import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useOrgStore } from '@/stores/orgStore'
import { ROUTES } from '@/constants'
import styles from './login.module.scss'

/**
 * 登录页
 *
 * - 只走 orgStore.login；token 始终由主进程 safeStorage 管理
 * - 登录成功跳转 Agent 工作台
 */
export default function Login(): React.JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const login = useOrgStore((s) => s.login)
  const status = useOrgStore((s) => s.status)
  const init = useOrgStore((s) => s.init)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    void init()
  }, [init])

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    const u = username.trim()
    const p = password.trim()
    // 防纯空格绕过 disabled: trim 后为空则不提交
    if (!u || !p || loading) return
    setLoading(true)
    setError('')
    try {
      if (!status?.configured) {
        setError(t('login.serverRequired', '请先在设置中配置企业服务器地址'))
        return
      }
      const result = await login(u, p)
      if (result.ok) navigate(ROUTES.chat, { replace: true })
      else setError(result.error ?? t('login.failed', '登录失败'))
    } catch (e) {
      setError(e instanceof Error ? e.message : t('login.failed', '登录失败'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className={styles.wrap}>
      <form className={styles.card} onSubmit={onSubmit}>
        <h1 className={styles.title}>{t('login.title')}</h1>
        <input
          className={styles.input}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder={t('login.username')}
          autoFocus
        />
        <input
          className={styles.input}
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={t('login.password')}
        />
        <button className={styles.submit} disabled={loading || !username || !password}>
          {loading ? t('common.loading') : t('login.submit')}
        </button>
        {error && <div role="alert" className={styles.error}>{error}</div>}
        <button type="button" className={styles.back} onClick={() => navigate(ROUTES.chat, { replace: true })}>
          {t('login.skip', '跳过，稍后登录')}
        </button>
      </form>
    </div>
  )
}
