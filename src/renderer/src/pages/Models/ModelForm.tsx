import { useState } from 'react'
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
      <h2>{model ? 'Edit Model' : 'Add Model'}</h2>
      <div className={styles.field}>
        <label htmlFor="name">Name</label>
        <input
          id="name"
          type="text"
          value={formData.name}
          onChange={(e) => setFormData({ ...formData, name: e.target.value })}
          required
        />
      </div>
      <div className={styles.field}>
        <label htmlFor="provider">Provider</label>
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
        <label htmlFor="contextWindow">Context Window</label>
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
        <label htmlFor="maxTokens">Max Tokens</label>
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
          {model ? 'Update' : 'Add'}
        </button>
        <button type="button" onClick={onCancel} className={styles.cancelButton}>
          Cancel
        </button>
      </div>
    </form>
  )
}
