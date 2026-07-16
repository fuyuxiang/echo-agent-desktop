import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { storage } from '@/utils'
import { toast } from '@/components/Toast'
import { useAgentStore } from '@/stores/agentStore'

interface SavedModelConfig {
  baseUrl: string
  modelName: string
  apiKey?: string
}

const LOCAL_CONFIG_KEY = 'modelConfig.local'
const API_KEY_STORE_KEY = 'openai-api-key'

export function ModelSection(): React.JSX.Element {
  const { t } = useTranslation()
  const configured = useAgentStore((s) => s.configured)

  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [modelName, setModelName] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    Promise.all([
      storage.get<SavedModelConfig>(LOCAL_CONFIG_KEY),
      window.api.store.secureGet(API_KEY_STORE_KEY)
    ]).then(([cfg, key]) => {
      if (cancelled) return
      if (cfg) {
        setBaseUrl(cfg.baseUrl)
        setModelName(cfg.modelName)
      }
      if (key) setApiKey(key)
      setLoaded(true)
    })
    return () => { cancelled = true }
  }, [])

  const handleSave = async (): Promise<void> => {
    if (saving) return
    const url = baseUrl.trim()
    const model = modelName.trim()
    const key = apiKey.trim()
    if (!url || !model || !key) {
      toast.error(t('model.fillAll', '请填写完整的接口地址、API Key 和模型名称'))
      return
    }
    setSaving(true)
    try {
      await window.api.store.secureSet(API_KEY_STORE_KEY, key)
      await storage.set(LOCAL_CONFIG_KEY, { baseUrl: url, modelName: model, apiKey: key })
      // 写入 echo-agent.yaml 的 models 段并重启进程使配置生效(取代旧的 TS Runtime 装配)
      await window.api.echoConfig.apply({ baseUrl: url, apiKey: key, model })
      useAgentStore.getState().setConfigured(true)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
      toast.success(t('model.saveSuccess', '模型配置已保存并生效'))
    } catch (e) {
      toast.error(`${t('model.saveFailed', '保存失败')}：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSaving(false)
    }
  }

  if (!loaded) return <div />

  return (
    <div>
      <h2 style={{ marginBottom: 8 }}>{t('model.title')}</h2>
      <p style={{ fontSize: 13, color: 'var(--color-text-3)', margin: '0 0 16px' }}>
        {t('model.protocolHint', '仅支持 OpenAI 兼容协议 API（大多数国内外厂商均已支持）')}
      </p>
      {!configured && (
        <p style={{ fontSize: 13, color: 'var(--color-warning, #f59e0b)', margin: '0 0 16px' }}>
          {t('model.notConfigured', '尚未配置模型，请填写以下信息以启用 Agent')}
        </p>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 420 }}>
        <label>
          <span style={{ display: 'block', marginBottom: 4, fontSize: 13, fontWeight: 500 }}>
            {t('model.baseUrl', '接口地址')}
          </span>
          <input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            style={{ width: '100%', padding: '8px 12px', borderRadius: 6, border: '1px solid var(--color-border)', boxSizing: 'border-box' }}
            placeholder="https://api.deepseek.com"
          />
        </label>

        <label>
          <span style={{ display: 'block', marginBottom: 4, fontSize: 13, fontWeight: 500 }}>
            API Key
          </span>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            style={{ width: '100%', padding: '8px 12px', borderRadius: 6, border: '1px solid var(--color-border)', boxSizing: 'border-box' }}
            placeholder={t('model.apiKeyPlaceholder', '粘贴你的 API Key')}
          />
        </label>

        <label>
          <span style={{ display: 'block', marginBottom: 4, fontSize: 13, fontWeight: 500 }}>
            {t('model.modelName', '模型名称')}
          </span>
          <input
            value={modelName}
            onChange={(e) => setModelName(e.target.value)}
            style={{ width: '100%', padding: '8px 12px', borderRadius: 6, border: '1px solid var(--color-border)', boxSizing: 'border-box' }}
            placeholder="deepseek-chat"
          />
        </label>

        <button
          onClick={handleSave}
          disabled={saving || !baseUrl.trim() || !modelName.trim() || !apiKey.trim()}
          style={{
            padding: '10px 20px',
            alignSelf: 'flex-start',
            borderRadius: 6,
            background: 'var(--color-primary)',
            color: '#fff',
            fontWeight: 600,
            cursor: saving ? 'not-allowed' : 'pointer',
            opacity: saving || !baseUrl.trim() || !modelName.trim() || !apiKey.trim() ? 0.5 : 1
          }}
        >
          {saving ? t('model.saving', '保存中…') : saved ? t('model.saved', '已保存') : t('model.save', '保存并启用')}
        </button>
      </div>
    </div>
  )
}
