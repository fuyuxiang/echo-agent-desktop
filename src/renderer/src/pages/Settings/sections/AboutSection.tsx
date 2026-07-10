import { useEffect, useState } from 'react'
import type { EchoAgentStatus } from '@shared/types/api'

type UpdateState = 'idle' | 'running' | 'success' | 'error'

const rowStyle = { display: 'flex', gap: 8, alignItems: 'center' }
const labelStyle = { color: 'var(--text-tertiary)', width: 120, flex: '0 0 120px' }

function statusText(status: EchoAgentStatus | null): string {
  if (!status) return '...'
  const labels: Record<EchoAgentStatus['phase'], string> = {
    idle: '空闲',
    installing: '安装中',
    starting: '启动中',
    ready: '已就绪',
    crashed: '已崩溃',
    updating: '升级中',
    error: '异常'
  }
  return status.port ? `${labels[status.phase]} :${status.port}` : labels[status.phase]
}

export function AboutSection(): React.JSX.Element {
  const [version, setVersion] = useState('')
  const [agentVersion, setAgentVersion] = useState<string | null | undefined>(undefined)
  const [agentStatus, setAgentStatus] = useState<EchoAgentStatus | null>(null)
  const [updateState, setUpdateState] = useState<UpdateState>('idle')
  const [updateError, setUpdateError] = useState('')

  useEffect(() => {
    window.api.app
      .getVersion()
      .then(setVersion)
      .catch(() => {})

    if (typeof window.api.echoAgent.getVersion === 'function') {
      window.api.echoAgent
        .getVersion()
        .then(setAgentVersion)
        .catch(() => setAgentVersion(null))
    }

    window.api.echoAgent
      .getStatus()
      .then(setAgentStatus)
      .catch(() => {})

    return window.api.echoAgent.onStatusChanged(setAgentStatus)
  }, [])

  const handleUpdate = async (): Promise<void> => {
    setUpdateState('running')
    setUpdateError('')
    try {
      await window.api.echoAgent.update()
      const [nextVersion, nextStatus] = await Promise.all([
        typeof window.api.echoAgent.getVersion === 'function'
          ? window.api.echoAgent.getVersion()
          : Promise.resolve(null),
        window.api.echoAgent.getStatus()
      ])
      setAgentVersion(nextVersion)
      setAgentStatus(nextStatus)
      if (nextStatus.phase === 'error' || nextStatus.phase === 'crashed') {
        setUpdateState('error')
        setUpdateError(nextStatus.message || 'echo-agent 升级后未能正常启动')
        return
      }
      setUpdateState('success')
    } catch (e) {
      setUpdateState('error')
      setUpdateError(e instanceof Error ? e.message : String(e))
    }
  }

  const updating = updateState === 'running' || agentStatus?.phase === 'updating'

  return (
    <div>
      <h2 style={{ marginBottom: 24 }}>关于</h2>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={rowStyle}>
          <span style={labelStyle}>Desktop 版本</span>
          <span>{version || '...'}</span>
        </div>
        <div style={rowStyle}>
          <span style={labelStyle}>echo-agent 版本</span>
          <span>{agentVersion === undefined ? '...' : agentVersion || '未安装'}</span>
        </div>
        <div style={rowStyle}>
          <span style={labelStyle}>echo-agent 状态</span>
          <span>{statusText(agentStatus)}</span>
        </div>
        <div style={{ ...rowStyle, marginTop: 4 }}>
          <span style={labelStyle} />
          <button
            type="button"
            disabled={updating}
            onClick={handleUpdate}
            style={{
              height: 32,
              padding: '0 14px',
              borderRadius: 6,
              border: '1px solid var(--color-primary)',
              background: updating ? 'var(--color-primary-soft)' : 'var(--color-primary)',
              color: updating ? 'var(--color-primary)' : '#fff',
              opacity: updating ? 0.7 : 1,
              cursor: updating ? 'default' : 'pointer'
            }}
          >
            {updating ? '升级中...' : '升级 echo-agent'}
          </button>
          {updateState === 'success' && (
            <span style={{ color: 'var(--color-primary)', fontSize: 12 }}>升级完成</span>
          )}
        </div>
        {updateState === 'error' && (
          <p style={{ fontSize: 12, color: 'var(--color-danger)', margin: 0 }}>
            {updateError || '升级失败'}
          </p>
        )}
        <p style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 16 }}>
          Echo Agent Desktop - AI Agent 本地客户端
        </p>
      </div>
    </div>
  )
}
