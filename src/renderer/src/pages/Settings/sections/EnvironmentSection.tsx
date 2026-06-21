import { useEffect, useState } from 'react'
import type { AgentEnvInfo } from '@shared/types'
import { toast } from '@/components/Toast'

export function EnvironmentSection(): React.JSX.Element {
  const [info, setInfo] = useState<AgentEnvInfo | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    window.api.agent
      .getEnvInfo()
      .then(setInfo)
      .catch(() => {})
  }, [])

  const handleUpgrade = async (): Promise<void> => {
    setLoading(true)
    try {
      const result = await window.api.agent.upgrade()
      if (result.success) {
        toast.success(result.version ? `已升级到 ${result.version}` : '升级完成')
      } else {
        toast.error(result.error ?? '升级失败')
      }
      const updated = await window.api.agent.getEnvInfo()
      setInfo(updated)
    } catch (e) {
      toast.error(`升级失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setLoading(false)
    }
  }

  const handleReset = async (): Promise<void> => {
    if (!confirm('确定重置 Python 环境？这将删除 venv 并重新安装。')) return
    setLoading(true)
    try {
      const result = await window.api.agent.resetEnv()
      if (result.success) {
        toast.success('环境已重置')
      } else {
        toast.error(result.error ?? '重置失败')
      }
      const updated = await window.api.agent.getEnvInfo()
      setInfo(updated)
    } catch (e) {
      toast.error(`重置失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div>
      <h2 style={{ marginBottom: 24 }}>运行环境</h2>
      {info ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <span style={{ color: 'var(--text-tertiary)', width: 120 }}>状态</span>
            <span>{info.status}</span>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <span style={{ color: 'var(--text-tertiary)', width: 120 }}>Python 版本</span>
            <span>{info.pythonVersion ?? '未安装'}</span>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <span style={{ color: 'var(--text-tertiary)', width: 120 }}>echo-agent 版本</span>
            <span>{info.echoAgentVersion ?? '未安装'}</span>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <span style={{ color: 'var(--text-tertiary)', width: 120 }}>Venv 路径</span>
            <span style={{ fontSize: 12 }}>{info.venvPath ?? '-'}</span>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
            <button
              onClick={handleUpgrade}
              disabled={loading}
              style={{ padding: '8px 16px', cursor: loading ? 'default' : 'pointer' }}
            >
              {loading ? '处理中…' : '升级 echo-agent'}
            </button>
            <button
              onClick={handleReset}
              disabled={loading}
              style={{
                padding: '8px 16px',
                cursor: loading ? 'default' : 'pointer',
                color: 'var(--color-danger, red)'
              }}
            >
              重置环境
            </button>
          </div>
        </div>
      ) : (
        <p>加载中...</p>
      )}
    </div>
  )
}
