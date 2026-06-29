import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { storage, shellOpen } from '@/utils'
import {
  detectOllama,
  listOllamaModels,
  pullOllamaModel,
  DEFAULT_OLLAMA_BASE_URL
} from '@/services/ollama'
import {
  LOCAL_OLLAMA_CONFIG_KEY,
  OLLAMA_PLACEHOLDER_API_KEY,
  toOllamaOpenAIBase,
  type LocalOllamaConfig
} from '@/services/model-config'
import { logger } from '@/utils/logger'

const OLLAMA_DOWNLOAD_URL = 'https://ollama.com/download'

export function LocalModelSection(): React.JSX.Element {
  const { t } = useTranslation()
  const [baseUrl, setBaseUrl] = useState(DEFAULT_OLLAMA_BASE_URL)
  const [online, setOnline] = useState<boolean | null>(null)
  const [version, setVersion] = useState<string>('')
  const [models, setModels] = useState<string[]>([])
  const [selected, setSelected] = useState('')
  const [pullName, setPullName] = useState('')
  const [detecting, setDetecting] = useState(false)
  const [pulling, setPulling] = useState(false)
  const [enabling, setEnabling] = useState(false)
  const [enabled, setEnabled] = useState(false)
  const [hint, setHint] = useState('')

  // 载入已持久化的本地模型配置
  useEffect(() => {
    storage.get<LocalOllamaConfig>(LOCAL_OLLAMA_CONFIG_KEY).then((cfg) => {
      if (!cfg) return
      setBaseUrl(cfg.baseUrl || DEFAULT_OLLAMA_BASE_URL)
      setSelected(cfg.modelName || '')
      setEnabled(!!cfg.enabled)
    })
  }, [])

  // 修改地址后, 上一次的检测结果立即失效(online/models/version),
  // 避免用户对新地址沿用旧地址的检测数据点"启用"
  const handleBaseUrlChange = (value: string): void => {
    setBaseUrl(value)
    setOnline(null)
    setModels([])
    setVersion('')
  }

  const handleDetect = async (): Promise<void> => {
    setDetecting(true)
    setHint('')
    const result = await detectOllama(baseUrl)
    setOnline(result.online)
    setVersion(result.version ?? '')
    if (result.online) {
      try {
        const list = await listOllamaModels(baseUrl)
        setModels(list)
        if (list.length && !selected) setSelected(list[0])
      } catch (e) {
        logger.warn('[LocalModel] 列出模型失败:', e)
        setModels([])
      }
    } else {
      setModels([])
    }
    setDetecting(false)
  }

  const handlePull = async (): Promise<void> => {
    const name = pullName.trim()
    if (!name) return
    setPulling(true)
    setHint(t('localModel.pulling', { name }))
    try {
      await pullOllamaModel(baseUrl, name)
      setHint(t('localModel.pullDone', { name }))
      setPullName('')
      const list = await listOllamaModels(baseUrl)
      setModels(list)
      setSelected(name)
    } catch (e) {
      setHint(t('localModel.pullFailed', { error: e instanceof Error ? e.message : String(e) }))
    }
    setPulling(false)
  }

  const handleEnable = async (): Promise<void> => {
    if (!selected) return
    setEnabling(true)
    setHint('')
    try {
      const cfg: LocalOllamaConfig = { enabled: true, baseUrl, modelName: selected }
      await storage.set(LOCAL_OLLAMA_CONFIG_KEY, cfg)
      // 写入 echo-agent.yaml 并重启进程,连本机 Ollama 的 OpenAI 兼容端点(取代旧的 TS Runtime 装配)
      await window.api.echoConfig.apply({
        baseUrl: toOllamaOpenAIBase(baseUrl),
        apiKey: OLLAMA_PLACEHOLDER_API_KEY,
        model: selected
      })
      setEnabled(true)
      setHint(t('localModel.enabledOk'))
    } catch (e) {
      setHint(e instanceof Error ? e.message : String(e))
    }
    setEnabling(false)
  }

  const handleDisable = async (): Promise<void> => {
    const cfg: LocalOllamaConfig = { enabled: false, baseUrl, modelName: selected }
    await storage.set(LOCAL_OLLAMA_CONFIG_KEY, cfg)
    setEnabled(false)
    setHint(t('localModel.disabledHint'))
  }

  return (
    <div>
      <h2 style={{ marginBottom: 8 }}>{t('localModel.title')}</h2>
      <p style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 0, marginBottom: 20 }}>
        {t('localModel.intro')}
      </p>

      {enabled && (
        <p style={{ fontSize: 13, color: 'var(--color-primary)', marginBottom: 16 }}>
          {t('localModel.currentlyEnabled', { name: selected })}
        </p>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 480 }}>
        <label>
          <span style={{ display: 'block', marginBottom: 4 }}>{t('localModel.address')}</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              value={baseUrl}
              onChange={(e) => handleBaseUrlChange(e.target.value)}
              style={{ flex: 1, padding: '8px', boxSizing: 'border-box' }}
              placeholder={DEFAULT_OLLAMA_BASE_URL}
            />
            <button onClick={handleDetect} disabled={detecting} style={{ padding: '8px 16px', cursor: 'pointer' }}>
              {detecting ? t('localModel.detecting') : t('localModel.detect')}
            </button>
          </div>
          <span style={{ display: 'block', marginTop: 4, fontSize: 12, color: 'var(--text-tertiary)' }}>
            {t('localModel.addressHint')}
          </span>
        </label>

        {online === true && (
          <>
            <p style={{ fontSize: 13, color: '#22c55e', margin: 0 }}>
              {t('localModel.online', { version: version || '-' })}
            </p>

            <label>
              <span style={{ display: 'block', marginBottom: 4 }}>{t('localModel.model')}</span>
              {models.length > 0 ? (
                <select
                  value={selected}
                  onChange={(e) => setSelected(e.target.value)}
                  style={{ width: '100%', padding: '8px' }}
                >
                  {models.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              ) : (
                <p style={{ fontSize: 13, color: 'var(--text-tertiary)', margin: 0 }}>
                  {t('localModel.noModels')}
                </p>
              )}
            </label>

            <label>
              <span style={{ display: 'block', marginBottom: 4 }}>{t('localModel.pullModel')}</span>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  value={pullName}
                  onChange={(e) => setPullName(e.target.value)}
                  style={{ flex: 1, padding: '8px', boxSizing: 'border-box' }}
                  placeholder="qwen2.5:7b"
                />
                <button onClick={handlePull} disabled={pulling} style={{ padding: '8px 16px', cursor: 'pointer' }}>
                  {pulling ? t('localModel.pullingShort') : t('localModel.pull')}
                </button>
              </div>
            </label>

            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={handleEnable}
                disabled={enabling || !selected}
                style={{ padding: '8px 16px', cursor: 'pointer', alignSelf: 'flex-start' }}
              >
                {enabling ? t('localModel.enabling') : t('localModel.enable')}
              </button>
              {enabled && (
                <button onClick={handleDisable} style={{ padding: '8px 16px', cursor: 'pointer' }}>
                  {t('localModel.disable')}
                </button>
              )}
            </div>
          </>
        )}

        {online === false && (
          <div
            style={{
              padding: 16,
              background: 'var(--bg-secondary)',
              borderRadius: 8,
              fontSize: 13,
              lineHeight: 1.7
            }}
          >
            <p style={{ margin: '0 0 8px', color: '#ef4444' }}>{t('localModel.offline')}</p>
            <p style={{ margin: '0 0 8px' }}>{t('localModel.installStep1')}</p>
            <button
              onClick={() => shellOpen.external(OLLAMA_DOWNLOAD_URL)}
              style={{ padding: '6px 12px', cursor: 'pointer', marginBottom: 8 }}
            >
              {t('localModel.openDownload')}
            </button>
            <p style={{ margin: '0 0 4px' }}>{t('localModel.installStep2')}</p>
            <pre style={{ margin: 0, fontSize: 12, color: 'var(--text-tertiary)' }}>
              ollama serve{'\n'}ollama pull qwen2.5:7b
            </pre>
          </div>
        )}

        {hint && <p style={{ fontSize: 12, color: 'var(--text-tertiary)', margin: 0 }}>{hint}</p>}
      </div>
    </div>
  )
}
