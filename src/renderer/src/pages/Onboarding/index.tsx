import { useState, useEffect } from 'react'
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

export default function OnboardingPage(): React.JSX.Element {
  const navigate = useNavigate()
  const [step, setStep] = useState<Step>('env-check')
  const [progress, setProgress] = useState<InstallProgressEvent | null>(null)
  const [selectedProvider, setSelectedProvider] = useState<ModelProviderConfig['name']>('openai')
  const [apiKey, setApiKey] = useState('')
  const [error, setError] = useState('')
  const [pipIndex, setPipIndex] = useState('')

  useEffect(() => {
    checkEnv()
  }, [])

  async function checkEnv(): Promise<void> {
    const info = await window.api.agent.getEnvInfo()
    if (info.status === 'ready') {
      setStep('model-config')
    } else {
      setStep('installing')
      startInstall()
    }
  }

  async function startInstall(): Promise<void> {
    setError('')
    const unsubscribe = window.api.agent.onInstallProgress((event) => {
      setProgress(event)
      if (event.error) setError(event.error)
    })

    const result = await window.api.agent.initEnv(pipIndex || undefined)
    unsubscribe()

    if (result.success) {
      setStep('model-config')
    } else {
      setError(result.error ?? '安装失败')
    }
  }

  async function handleModelSubmit(): Promise<void> {
    if (!apiKey.trim()) {
      setError('请输入 API Key')
      return
    }

    const keyMapping: Record<string, string> = {
      openai: 'openai-api-key',
      anthropic: 'anthropic-api-key',
      gemini: 'gemini-api-key',
      openrouter: 'openrouter-api-key'
    }
    await window.api.store.secureSet(keyMapping[selectedProvider], apiKey)

    await window.api.agent.updateConfig({
      defaultModel:
        selectedProvider === 'openai'
          ? 'gpt-4o'
          : selectedProvider === 'anthropic'
            ? 'claude-sonnet-4-20250514'
            : '',
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
