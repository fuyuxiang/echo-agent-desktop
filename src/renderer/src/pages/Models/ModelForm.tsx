import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ModelConfig } from '@shared/model-types'
import styles from './models.module.scss'

interface ModelFormProps {
  model?: ModelConfig | null
  onSubmit: (data: {
    name: string
    provider: string
    contextWindow: number
    maxTokens: number
  }) => void
  onCancel: () => void
}

export default function ModelForm({
  model,
  onSubmit,
  onCancel
}: ModelFormProps): React.JSX.Element {
  const { t } = useTranslation()
  const [formData, setFormData] = useState({
    name: model?.name || '',
    provider: model?.provider || 'openai',
    contextWindow: model?.contextWindow || 128000,
    maxTokens: model?.maxTokens || 4096
  })

  const handleSubmit = (e: React.FormEvent): void => {
    e.preventDefault()
    onSubmit(formData)
  }

  return (
    <form onSubmit={handleSubmit} className={styles.form}>
      <h2>{model ? t('models.editModel') : t('models.addModel')}</h2>
      <div className={styles.field}>
        <label htmlFor="name">{t('models.name')}</label>
        <input
          id="name"
          type="text"
          value={formData.name}
          onChange={(e) => setFormData({ ...formData, name: e.target.value })}
          required
        />
      </div>
      <div className={styles.field}>
        <label htmlFor="provider">{t('models.provider')}</label>
        <select
          id="provider"
          value={formData.provider}
          onChange={(e) => setFormData({ ...formData, provider: e.target.value })}
        >
          <option value="openai">OpenAI</option>
          <option value="anthropic">Anthropic</option>
          <option value="google">Google</option>
          <option value="openrouter">OpenRouter</option>
          <option value="custom">Custom</option>
        </select>
      </div>
      <div className={styles.field}>
        <label htmlFor="contextWindow">{t('models.contextWindow')}</label>
        <input
          id="contextWindow"
          type="number"
          value={formData.contextWindow}
          onChange={(e) =>
            setFormData({ ...formData, contextWindow: parseInt(e.target.value) })
          }
          required
        />
      </div>
      <div className={styles.field}>
        <label htmlFor="maxTokens">{t('models.maxTokens')}</label>
        <input
          id="maxTokens"
          type="number"
          value={formData.maxTokens}
          onChange={(e) =>
            setFormData({ ...formData, maxTokens: parseInt(e.target.value) })
          }
          required
        />
      </div>
      <div className={styles.actions}>
        <button type="submit" className={styles.submitButton}>
          {model ? t('models.update') : t('models.add')}
        </button>
        <button type="button" onClick={onCancel} className={styles.cancelButton}>
          {t('models.cancel')}
        </button>
      </div>
    </form>
  )
}
