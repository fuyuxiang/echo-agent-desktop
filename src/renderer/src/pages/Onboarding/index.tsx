import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { ROUTES } from '@/constants'
import { useAgentStore } from '@/stores/agentStore'
import type { InstallProgressEvent, ModelProviderConfig } from '@shared/types'
import styles from './onboarding.module.scss'

type Step = 'env-check' | 'installing' | 'model-config' | 'starting' | 'done'

const PROVIDERS: { name: ModelProviderConfig['name']; label: string }[] = [
  { name: 'openai', label: 'OpenAI' },
  { name: 'anthropic', label: 'Anthropic' },
  { name: 'gemini', label: 'Google Gemini' },
  { name: 'openrouter', label: 'OpenRouter' }
]

/** 各 provider 的默认模型: 确保任意 provider 完成引导后下发给 agent 的 defaultModel 都非空 */
const DEFAULT_MODEL_BY_PROVIDER: Record<ModelProviderConfig['name'], string> = {
  openai: 'gpt-4o',
  anthropic: 'claude-sonnet-4-20250514',
  gemini: 'gemini-1.5-pro',
  openrouter: 'openai/gpt-4o',
  bedrock: 'anthropic.claude-3-5-sonnet-20241022-v2:0'
}

export default function OnboardingPage(): React.JSX.Element {
  const navigate = useNavigate()
  const [step, setStep] = useState<Step>('env-check')
  const [progress, setProgress] = useState<InstallProgressEvent | null>(null)
  const [selectedProvider, setSelectedProvider] = useState<ModelProviderConfig['name']>('openai')
  const [apiKey, setApiKey] = useState('')
  const [error, setError] = useState('')
  const [pipIndex, setPipIndex] = useState('')
  // 安装进度订阅的取消函数: 组件卸载时清理, 避免卸载后 setState 与监听泄漏
  const unsubscribeRef = useRef<(() => void) | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    checkEnv()
    return () => {
      mountedRef.current = false
      unsubscribeRef.current?.()
      unsubscribeRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function checkEnv(): Promise<void> {
    try {
      const info = await window.api.agent.getEnvInfo()
      if (!mountedRef.current) return
      if (info.status === 'ready') {
        setStep('model-config')
      } else {
        setStep('installing')
        startInstall()
      }
    } catch (e) {
      if (!mountedRef.current) return
      // 环境检查失败时不要停在"正在检查环境..."死态, 转到可重试的安装步骤
      setStep('installing')
      setError(`环境检查失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  async function startInstall(): Promise<void> {
    setError('')
    // 清理上一次订阅(重试场景), 避免多次叠加
    unsubscribeRef.current?.()
    const unsubscribe = window.api.agent.onInstallProgress((event) => {
      if (!mountedRef.current) return
      setProgress(event)
      if (event.error) setError(event.error)
    })
    unsubscribeRef.current = unsubscribe

    try {
      const result = await window.api.agent.initEnv(pipIndex || undefined)
      if (!mountedRef.current) return
      if (result.success) {
        setStep('model-config')
      } else {
        setError(result.error ?? '安装失败')
      }
    } catch (e) {
      if (mountedRef.current) setError(`安装失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      unsubscribe()
      if (unsubscribeRef.current === unsubscribe) unsubscribeRef.current = null
    }
  }

  async function handleModelSubmit(): Promise<void> {
    if (!apiKey.trim()) {
      setError('请输入 API Key')
      return
    }
    setError('')

    const keyMapping: Record<string, string> = {
      openai: 'openai-api-key',
      anthropic: 'anthropic-api-key',
      gemini: 'gemini-api-key',
      openrouter: 'openrouter-api-key'
    }

    try {
      await window.api.store.secureSet(keyMapping[selectedProvider], apiKey)

      await window.api.agent.updateConfig({
        defaultModel: DEFAULT_MODEL_BY_PROVIDER[selectedProvider],
        providers: [{ name: selectedProvider }]
      })

      setStep('starting')
      const result = await window.api.agent.start()
      if (result.success && result.port) {
        useAgentStore.getState().setLocalPort(result.port)
        setStep('done')
        setTimeout(() => navigate(ROUTES.chat), 1000)
      } else {
        setError(result.error ?? 'Agent 启动失败')
        setStep('model-config')
      }
    } catch (e) {
      setError(`配置失败：${e instanceof Error ? e.message : String(e)}`)
      setStep('model-config')
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <h1 className={styles.title}>Echo Agent Desktop</h1>

        {step === 'env-check' && <p>正在检查环境...</p>}

        {step === 'installing' && (
          <div className={styles.section}>
            <h2>初始化环境</h2>
            {progress && (
              <div className={styles.progress}>
                <div className={styles.progressBar} style={{ width: `${progress.progress}%` }} />
                <p className={styles.progressText}>{progress.message}</p>
              </div>
            )}
            {error && (
              <div className={styles.error}>
                <p>{error}</p>
                <div className={styles.retryRow}>
                  <input
                    placeholder="pip 镜像源(可选)"
                    value={pipIndex}
                    onChange={(e) => setPipIndex(e.target.value)}
                  />
                  <button onClick={() => startInstall()}>重试</button>
                </div>
              </div>
            )}
          </div>
        )}

        {step === 'model-config' && (
          <div className={styles.section}>
            <h2>配置 AI 模型</h2>
            <div className={styles.providerList}>
              {PROVIDERS.map((p) => (
                <button
                  key={p.name}
                  className={`${styles.providerBtn} ${selectedProvider === p.name ? styles.selected : ''}`}
                  onClick={() => setSelectedProvider(p.name)}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <input
              className={styles.keyInput}
              type="password"
              placeholder={`输入 ${PROVIDERS.find((p) => p.name === selectedProvider)?.label} API Key`}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
            {error && <p className={styles.errorText}>{error}</p>}
            <button className={styles.submitBtn} onClick={() => handleModelSubmit()}>
              开始使用
            </button>
          </div>
        )}

        {step === 'starting' && <p>正在启动 Agent...</p>}
        {step === 'done' && <p>启动成功，即将进入对话...</p>}
      </div>
    </div>
  )
}
