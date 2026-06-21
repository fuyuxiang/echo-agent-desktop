import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useUserStore } from '@/stores/userStore'
import { ROUTES } from '@/constants'
import styles from './login.module.scss'

/**
 * 登录页
 *
 * - 调用 userStore.signIn(走服务端 login,token 加密落盘)
 * - 业务错误已由请求拦截器统一 toast,这里只负责跳转
 * - 登录成功跳转 Agent 工作台
 */
export default function Login(): React.JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const signIn = useUserStore((s) => s.signIn)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    const u = username.trim()
    const p = password.trim()
    // 防纯空格绕过 disabled: trim 后为空则不提交
    if (!u || !p || loading) return
    setLoading(true)
    try {
      await signIn(u, p)
      navigate(ROUTES.chat, { replace: true })
    } catch {
      // 业务错误已由拦截器 toast,无需重复处理
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
      </form>
    </div>
  )
}
