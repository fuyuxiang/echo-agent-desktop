import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from '@/components/Toast'
import { useASRStore } from '@/stores/asrStore'

/**
 * ASR 配置卡(2026-08 ASR 云端化重构)
 *
 * 设计要点(对齐 ModelSection):
 * - 真实 API Key 仅经主进程 IPC 写 safeStorage,本组件不接触 storeKey
 * - 默认 baseUrl/model 给硅基流动 TeleSpeechASR 的现成值,新用户开箱即用
 * - 未配置时显示警告,引导用户填写
 */
export function ASRSection(): React.JSX.Element {
  const { t } = useTranslation()
  const config = useASRStore((s) => s.config)
  const saving = useASRStore((s) => s.saving)
  const loadConfig = useASRStore((s) => s.loadConfig)
  const saveConfig = useASRStore((s) => s.saveConfig)
  const clearConfig = useASRStore((s) => s.clearConfig)

  const [baseUrl, setBaseUrl] = useState('')
  const [modelName, setModelName] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    void loadConfig()
  }, [loadConfig])

  useEffect(() => {
    // 持久化有 baseUrl/model 时回填表单(apiKey 不回填——非明文存储,必须重输)
    if (config) {
      setBaseUrl(config.baseUrl || '')
      setModelName(config.model || '')
    }
  }, [config])

  const isConfigured = !!config?.baseUrl && !!config.model && !!config.apiKeyRef

  const handleSave = async (): Promise<void> => {
    const url = baseUrl.trim()
    const model = modelName.trim()
    const key = apiKey.trim()
    if (!url || !model || !key) {
      toast.error(t('asr.fillAll', '请填写完整的接口地址、API Key 和模型名称'))
      return
    }
    try {
      await saveConfig({ baseUrl: url, model, apiKey: key })
      setSaved(true)
      setApiKey('') // 输入框清空,避免明文长期挂在 UI 状态
      setTimeout(() => setSaved(false), 2000)
      toast.success(t('asr.saveSuccess', 'ASR 配置已保存'))
    } catch (e) {
      toast.error(`${t('asr.saveFailed', '保存失败')}：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const handleClear = async (): Promise<void> => {
    try {
      await clearConfig()
      setBaseUrl('')
      setModelName('')
      setApiKey('')
      toast.success(t('asr.cleared', 'ASR 配置已清空'))
    } catch (e) {
      toast.error(`${t('asr.clearFailed', '清空失败')}：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return (
    <div>
      <h2 style={{ marginBottom: 8 }}>{t('asr.title', '语音识别')}</h2>
      <p style={{ fontSize: 13, color: 'var(--color-text-3)', margin: '0 0 16px' }}>
        {t('asr.protocolHint', '默认使用硅基流动 TeleSpeechASR,支持替换为兼容 OpenAI Whisper 协议的任意端点')}
      </p>
      {!isConfigured && (
        <p style={{ fontSize: 13, color: 'var(--color-warning, #f59e0b)', margin: '0 0 16px' }}>
          {t('asr.notConfigured', '尚未配置 ASR,语音输入与会议转写将不可用')}
        </p>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 420 }}>
        <label>
          <span style={{ display: 'block', marginBottom: 4, fontSize: 13, fontWeight: 500 }}>
            {t('asr.baseUrl', '接口地址')}
          </span>
          <input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            style={{
              width: '100%',
              padding: '8px 12px',
              borderRadius: 6,
              border: '1px solid var(--color-border)',
              boxSizing: 'border-box'
            }}
            placeholder="https://api.siliconflow.cn/v1/audio/transcriptions"
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
            placeholder={
              isConfigured
                ? t('asr.apiKeyKeep', '已配置,留空则保留旧值;如需更换请输入新 Key')
                : t('asr.apiKeyPlaceholder', '粘贴你的 API Key')
            }
            style={{
              width: '100%',
              padding: '8px 12px',
              borderRadius: 6,
              border: '1px solid var(--color-border)',
              boxSizing: 'border-box'
            }}
          />
        </label>

        <label>
          <span style={{ display: 'block', marginBottom: 4, fontSize: 13, fontWeight: 500 }}>
            {t('asr.modelName', '模型名称')}
          </span>
          <input
            value={modelName}
            onChange={(e) => setModelName(e.target.value)}
            style={{
              width: '100%',
              padding: '8px 12px',
              borderRadius: 6,
              border: '1px solid var(--color-border)',
              boxSizing: 'border-box'
            }}
            placeholder="TeleAI/TeleSpeechASR"
          />
        </label>

        <div style={{ display: 'flex', gap: 12 }}>
          <button
            onClick={handleSave}
            disabled={saving || !baseUrl.trim() || !modelName.trim() || !apiKey.trim()}
            style={{
              padding: '10px 20px',
              borderRadius: 6,
              background: 'var(--color-primary)',
              color: '#fff',
              fontWeight: 600,
              cursor: saving ? 'not-allowed' : 'pointer',
              opacity:
                saving || !baseUrl.trim() || !modelName.trim() || !apiKey.trim() ? 0.5 : 1
            }}
          >
            {saving
              ? t('asr.saving', '保存中…')
              : saved
                ? t('asr.saved', '已保存')
                : t('asr.save', '保存并启用')}
          </button>
          {isConfigured && (
            <button
              onClick={handleClear}
              style={{
                padding: '10px 20px',
                borderRadius: 6,
                background: 'transparent',
                color: 'var(--color-text-2)',
                border: '1px solid var(--color-border)',
                cursor: 'pointer'
              }}
            >
              {t('asr.clear', '清空配置')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}