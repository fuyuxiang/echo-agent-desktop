import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from '@/components/Toast'

const API_KEY = 'asr-api-key'
const BASE_URL_KEY = 'asr.baseUrl'
const MODEL_KEY = 'asr.model'
const DEFAULT_BASE_URL = 'https://api.siliconflow.cn/v1/audio/transcriptions'
const DEFAULT_MODEL = 'TeleAI/TeleSpeechASR'

export function AsrSection(): React.JSX.Element {
  const { t } = useTranslation()
  const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE_URL)
  const [model, setModel] = useState(DEFAULT_MODEL)
  const [apiKey, setApiKey] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    Promise.all([
      window.api.store.get<string>(BASE_URL_KEY),
      window.api.store.get<string>(MODEL_KEY),
      window.api.store.secureGet(API_KEY)
    ]).then(([url, savedModel, key]) => {
      if (cancelled) return
      if (url) setBaseUrl(url)
      if (savedModel) setModel(savedModel)
      if (key) setApiKey(key)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const save = async (): Promise<void> => {
    const url = baseUrl.trim()
    const modelName = model.trim()
    const key = apiKey.trim()
    if (!url || !modelName || !key) {
      toast.error(t('asr.fillAll', '请填写完整的 ASR 地址、模型和 API Key'))
      return
    }
    try {
      const parsed = new URL(url)
      if (parsed.protocol !== 'https:' && !['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)) {
        throw new Error(t('asr.httpsRequired', 'ASR 接口必须使用 HTTPS'))
      }
      setSaving(true)
      await Promise.all([
        window.api.store.set(BASE_URL_KEY, parsed.toString()),
        window.api.store.set(MODEL_KEY, modelName),
        window.api.store.secureSet(API_KEY, key)
      ])
      toast.success(t('asr.saved', '语音识别配置已安全保存'))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const inputStyle = {
    width: '100%',
    padding: '8px 12px',
    borderRadius: 6,
    border: '1px solid var(--color-border)',
    boxSizing: 'border-box' as const
  }

  return (
    <div>
      <h2>{t('asr.title', '语音识别')}</h2>
      <p style={{ fontSize: 13, color: 'var(--color-text-3)', margin: '0 0 16px' }}>
        {t('asr.securityHint', 'API Key 使用系统密钥链加密保存，不会写入普通配置或 Agent 配置。')}
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 520 }}>
        <label>
          <span style={{ display: 'block', marginBottom: 4 }}>{t('asr.baseUrl', '转写接口地址')}</span>
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} style={inputStyle} />
        </label>
        <label>
          <span style={{ display: 'block', marginBottom: 4 }}>{t('asr.model', '模型')}</span>
          <input value={model} onChange={(e) => setModel(e.target.value)} style={inputStyle} />
        </label>
        <label>
          <span style={{ display: 'block', marginBottom: 4 }}>API Key</span>
          <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} style={inputStyle} />
        </label>
        <button type="button" onClick={save} disabled={saving} style={{ alignSelf: 'flex-start', padding: '10px 20px' }}>
          {saving ? t('common.loading') : t('common.save', '保存')}
        </button>
      </div>
    </div>
  )
}
