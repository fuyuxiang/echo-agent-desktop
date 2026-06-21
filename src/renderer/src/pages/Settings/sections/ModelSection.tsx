import { useState, useEffect } from 'react'

const PROVIDERS = ['openai', 'anthropic', 'gemini', 'bedrock', 'openrouter'] as const
const KEY_MAP: Record<string, string> = {
  openai: 'openai-api-key',
  anthropic: 'anthropic-api-key',
  gemini: 'gemini-api-key',
  bedrock: 'aws-access-key-id',
  openrouter: 'openrouter-api-key'
}

export function ModelSection(): React.JSX.Element {
  const [provider, setProvider] = useState<string>('openai')
  const [apiKey, setApiKey] = useState('')
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    window.api.store.secureGet(KEY_MAP[provider]).then((val) => setApiKey(val ?? ''))
  }, [provider])

  const handleSave = async (): Promise<void> => {
    await window.api.store.secureSet(KEY_MAP[provider], apiKey)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  return (
    <div>
      <h2 style={{ marginBottom: 24 }}>模型配置</h2>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 400 }}>
        <label>
          <span style={{ display: 'block', marginBottom: 4 }}>Provider</span>
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            style={{ width: '100%', padding: '8px' }}
          >
            {PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span style={{ display: 'block', marginBottom: 4 }}>API Key</span>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            style={{ width: '100%', padding: '8px', boxSizing: 'border-box' }}
            placeholder={`输入 ${KEY_MAP[provider]}`}
          />
        </label>
        <button
          onClick={handleSave}
          style={{ padding: '8px 16px', alignSelf: 'flex-start', cursor: 'pointer' }}
        >
          {saved ? '已保存' : '保存'}
        </button>
      </div>
    </div>
  )
}
