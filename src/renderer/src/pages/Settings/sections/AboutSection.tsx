import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { EchoAgentStatus } from '@shared/types/api'

type UpdateState = 'idle' | 'running' | 'success' | 'error'

const rowStyle = { display: 'flex', gap: 8, alignItems: 'center' }
const labelStyle = { color: 'var(--text-tertiary)', width: 120, flex: '0 0 120px' }

// 状态 → i18n key 映射,避免在 JSX 里写大段硬编码中文
const STATUS_KEY = {
  idle: 'about.status.idle',
  installing: 'about.status.installing',
  starting: 'about.status.starting',
  ready: 'about.status.ready',
  crashed: 'about.status.crashed',
  updating: 'about.status.updating',
  error: 'about.status.error'
} as const satisfies Record<EchoAgentStatus['phase'], string>

function statusText(
  status: EchoAgentStatus | null,
  t: (key: string) => string
): string {
  if (!status) return '...'
  const label = t(STATUS_KEY[status.phase])
  return status.port ? `${label} :${status.port}` : label
}

export function AboutSection(): React.JSX.Element {
  const { t } = useTranslation()
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
        setUpdateError(
          nextStatus.message || t('about.updateFailedGeneric', 'echo-agent 升级后未能正常启动')
        )
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
      <h2 style={{ marginBottom: 24 }}>{t('about.title')}</h2>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={rowStyle}>
          <span style={labelStyle}>{t('about.desktopVersion')}</span>
          <span>{version || '...'}</span>
        </div>
        <div style={rowStyle}>
          <span style={labelStyle}>{t('about.agentVersion')}</span>
          <span>
            {agentVersion === undefined
              ? '...'
              : agentVersion || t('about.notInstalled')}
          </span>
        </div>
        <div style={rowStyle}>
          <span style={labelStyle}>{t('about.agentStatus')}</span>
          <span>{statusText(agentStatus, t)}</span>
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
            {updating ? t('about.updating') : t('about.update')}
          </button>
          {updateState === 'success' && (
            <span style={{ color: 'var(--color-primary)', fontSize: 12 }}>
              {t('about.updated')}
            </span>
          )}
        </div>
        {updateState === 'error' && (
          <p style={{ fontSize: 12, color: 'var(--color-danger)', margin: 0 }}>
            {updateError || t('about.updateFailed')}
          </p>
        )}
        <p style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 16 }}>
          {t('about.tagline')}
        </p>
      </div>
    </div>
  )
}
