import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { storage } from '@/utils'
import { fetchModelConfig, type ModelConfigDTO } from '@/services/server'
import {
  resolveEffectiveModelConfig,
  type LocalModelConfig
} from '@/services/model-config'

const PROVIDERS = ['openai', 'anthropic', 'gemini', 'bedrock', 'openrouter'] as const
type Provider = (typeof PROVIDERS)[number]
const KEY_MAP: Record<string, string> = {
  openai: 'openai-api-key',
  anthropic: 'anthropic-api-key',
  gemini: 'gemini-api-key',
  bedrock: 'aws-access-key-id',
  openrouter: 'openrouter-api-key'
}

/** 本地覆盖配置持久化 key(走 storage,不用 localStorage) */
const LOCAL_CONFIG_KEY = 'modelConfig.local'

export function ModelSection(): React.JSX.Element {
  const { t } = useTranslation()
  const [provider, setProvider] = useState<Provider>('openai')
  const [apiKey, setApiKey] = useState('')
  const [saved, setSaved] = useState(false)

  // 服务端下发配置(A)
  const [serverConfig, setServerConfig] = useState<ModelConfigDTO | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)

  // 本地表单(B):允许覆盖时可编辑
  const [baseUrl, setBaseUrl] = useState('')
  const [modelName, setModelName] = useState('')

  // 加载服务端配置 + 本地覆盖
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setLoadError(false)
    Promise.all([
      fetchModelConfig(),
      storage.get<LocalModelConfig>(LOCAL_CONFIG_KEY)
    ])
      .then(([server, local]) => {
        if (cancelled) return
        setServerConfig(server)
        // 允许覆盖且有本地配置时回填本地值,否则展示服务端值
        if (server.allowLocalOverride && local) {
          setBaseUrl(local.baseUrl)
          setModelName(local.modelName)
        } else {
          setBaseUrl(server.baseUrl ?? '')
          setModelName(server.modelName ?? '')
        }
      })
      .catch(() => {
        if (!cancelled) setLoadError(true)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // 切换 provider 时读取对应密钥
  useEffect(() => {
    window.api.store.secureGet(KEY_MAP[provider]).then((val) => setApiKey(val ?? ''))
  }, [provider])

  const canOverride = serverConfig?.allowLocalOverride === true

  const handleSave = async (): Promise<void> => {
    await window.api.store.secureSet(KEY_MAP[provider], apiKey)

    if (serverConfig) {
      // 仅当允许覆盖时才持久化本地配置,否则确保不残留旧覆盖
      const local: LocalModelConfig | null = canOverride ? { baseUrl, modelName } : null
      if (canOverride) {
        await storage.set(LOCAL_CONFIG_KEY, local)
      } else {
        await storage.remove(LOCAL_CONFIG_KEY)
      }

      const effective = resolveEffectiveModelConfig(serverConfig, local)
      await window.api.agent.updateConfig({
        defaultModel: effective.modelName ?? '',
        providers: [
          {
            name: provider,
            ...(effective.baseUrl ? { apiBase: effective.baseUrl } : {})
          }
        ]
      })
    }

    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const effectiveSource =
    serverConfig && resolveEffectiveModelConfig(serverConfig, canOverride ? { baseUrl, modelName } : null).source

  return (
    <div>
      <h2 style={{ marginBottom: 24 }}>{t('model.title')}</h2>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 400 }}>
        {loading && <p style={{ fontSize: 13 }}>{t('model.loading')}</p>}
        {loadError && (
          <p style={{ fontSize: 13, color: '#ef4444', margin: 0 }}>{t('model.loadFailed')}</p>
        )}

        {serverConfig && (
          <p style={{ fontSize: 12, color: 'var(--text-tertiary)', margin: 0 }}>
            {canOverride ? t('model.overrideAllowed') : t('model.serverManaged')}
          </p>
        )}

        <label>
          <span style={{ display: 'block', marginBottom: 4 }}>{t('model.provider')}</span>
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value as Provider)}
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
          <span style={{ display: 'block', marginBottom: 4 }}>{t('model.baseUrl')}</span>
          <input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            readOnly={!canOverride}
            style={{
              width: '100%',
              padding: '8px',
              boxSizing: 'border-box',
              opacity: canOverride ? 1 : 0.6
            }}
            placeholder="https://api.openai.com/v1"
          />
        </label>

        <label>
          <span style={{ display: 'block', marginBottom: 4 }}>{t('model.modelName')}</span>
          <input
            value={modelName}
            onChange={(e) => setModelName(e.target.value)}
            readOnly={!canOverride}
            style={{
              width: '100%',
              padding: '8px',
              boxSizing: 'border-box',
              opacity: canOverride ? 1 : 0.6
            }}
            placeholder="gpt-4o"
          />
        </label>

        <label>
          <span style={{ display: 'block', marginBottom: 4 }}>{t('model.apiKey')}</span>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            style={{ width: '100%', padding: '8px', boxSizing: 'border-box' }}
            placeholder={t('model.apiKeyPlaceholder', { key: KEY_MAP[provider] })}
          />
          {serverConfig?.hasCredential && (
            <span style={{ display: 'block', marginTop: 4, fontSize: 12, color: 'var(--text-tertiary)' }}>
              {t('model.credentialFromServer')}
            </span>
          )}
        </label>

        {effectiveSource && (
          <p style={{ fontSize: 12, color: 'var(--text-tertiary)', margin: 0 }}>
            {effectiveSource === 'local' ? t('model.effectiveLocal') : t('model.effectiveServer')}
          </p>
        )}

        <button
          onClick={handleSave}
          disabled={loading}
          style={{ padding: '8px 16px', alignSelf: 'flex-start', cursor: 'pointer' }}
        >
          {saved ? t('model.saved') : t('model.save')}
        </button>
      </div>
    </div>
  )
}
