import { useEffect, useState } from 'react'

export function AboutSection(): React.JSX.Element {
  const [version, setVersion] = useState('')

  useEffect(() => {
    window.api.app
      .getVersion()
      .then(setVersion)
      .catch(() => {})
  }, [])

  return (
    <div>
      <h2 style={{ marginBottom: 24 }}>关于</h2>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <span style={{ color: 'var(--text-tertiary)', width: 80 }}>版本</span>
          <span>{version || '...'}</span>
        </div>
        <p style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 16 }}>
          Echo Agent Desktop - AI Agent 本地客户端
        </p>
      </div>
    </div>
  )
}
