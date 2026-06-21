import { useState } from 'react'
import { useAgentStore } from '@/stores/agentStore'
import { agentWs } from '@/services/agent/ws'

export function ConnectionSection(): React.JSX.Element {
  const { connectionMode, remoteUrl, remoteToken, setConnectionMode, setRemoteConfig } =
    useAgentStore()
  const [url, setUrl] = useState(remoteUrl)
  const [token, setToken] = useState(remoteToken)
  const [saved, setSaved] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null)

  const handleModeChange = (mode: 'local' | 'remote'): void => {
    setConnectionMode(mode)
    if (mode === 'local') {
      window.api.agent.getPort().then((port) => {
        if (port) useAgentStore.getState().setLocalPort(port)
      })
    }
    setSaved(false)
    setTestResult(null)
  }

  const handleSave = (): void => {
    setRemoteConfig(url, token)
    setSaved(true)
    setTestResult(null)
    setTimeout(() => setSaved(false), 2000)

    // 保存后断开重连，使新 token 生效
    if (connectionMode === 'remote' && url) {
      agentWs.disconnect()
      const wsUrl = url.replace(/^http/, 'ws') + '/ws'
      setTimeout(() => agentWs.connect(wsUrl, 'default', token), 300)
    }
  }

  const handleTestConnection = async (): Promise<void> => {
    if (!url) {
      setTestResult({ ok: false, msg: '请填写远程地址' })
      return
    }
    setTesting(true)
    setTestResult(null)

    try {
      const healthUrl = url.replace(/\/+$/, '') + '/api/v1/health'
      const headers: Record<string, string> = {}
      if (token) headers['X-Echo-Agent-Token'] = token

      const resp = await window.api.agent.httpProxy({ url: healthUrl, headers })
      if (resp.ok) {
        const data = JSON.parse(resp.body)
        setTestResult({ ok: true, msg: `连接成功 — 状态: ${data.status || 'ok'}` })
      } else if (resp.status === 401 || resp.status === 403) {
        setTestResult({ ok: false, msg: `认证失败 (${resp.status})，请检查 Token` })
      } else if (resp.status === 0) {
        setTestResult({ ok: false, msg: `无法连接: ${resp.body}` })
      } else {
        setTestResult({ ok: false, msg: `服务端返回 ${resp.status}` })
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setTestResult({ ok: false, msg: `无法连接: ${msg}` })
    } finally {
      setTesting(false)
    }
  }

  return (
    <div>
      <h2 style={{ marginBottom: 24 }}>连接设置</h2>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 400 }}>
        <label>
          <span style={{ display: 'block', marginBottom: 4 }}>连接模式</span>
          <select
            value={connectionMode}
            onChange={(e) => handleModeChange(e.target.value as 'local' | 'remote')}
            style={{ width: '100%', padding: '8px' }}
          >
            <option value="local">本地模式</option>
            <option value="remote">远程模式</option>
          </select>
        </label>
        {connectionMode === 'remote' && (
          <>
            <label>
              <span style={{ display: 'block', marginBottom: 4 }}>远程地址</span>
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                style={{ width: '100%', padding: '8px', boxSizing: 'border-box' }}
                placeholder="http://your-server:9000"
              />
            </label>
            <label>
              <span style={{ display: 'block', marginBottom: 4 }}>Token</span>
              <input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                style={{ width: '100%', padding: '8px', boxSizing: 'border-box' }}
                placeholder="sk-ea-..."
              />
            </label>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={handleSave} style={{ padding: '8px 16px', cursor: 'pointer' }}>
                {saved ? '已保存' : '保存'}
              </button>
              <button
                onClick={handleTestConnection}
                disabled={testing}
                style={{ padding: '8px 16px', cursor: 'pointer' }}
              >
                {testing ? '测试中...' : '测试连接'}
              </button>
            </div>
            {testResult && (
              <p style={{ fontSize: 13, color: testResult.ok ? '#22c55e' : '#ef4444', margin: 0 }}>
                {testResult.msg}
              </p>
            )}
          </>
        )}
        {connectionMode === 'local' && (
          <p style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
            本地模式将自动连接本机 Agent 进程，无需手动配置。
          </p>
        )}
      </div>
    </div>
  )
}
