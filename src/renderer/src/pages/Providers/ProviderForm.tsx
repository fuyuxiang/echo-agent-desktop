import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ProviderConfig, ProviderType } from '@shared/provider-types'
import styles from './providers.module.scss'

interface ProviderFormProps {
  provider?: ProviderConfig | null
  onSubmit: (data: {
    name: string
    type: ProviderType | string
    apiKey?: string
    baseUrl?: string
    description?: string
  }) => void
  onCancel: () => void
}

export default function ProviderForm({
  provider,
  onSubmit,
  onCancel
}: ProviderFormProps): React.JSX.Element {
  const { t } = useTranslation()
  const [formData, setFormData] = useState({
    name: provider?.name || '',
    type: provider?.type || 'openai',
    apiKey: provider?.apiKey || '',
    baseUrl: provider?.baseUrl || '',
    description: provider?.description || ''
  })

  const handleSubmit = (e: React.FormEvent): void => {
    e.preventDefault()
    onSubmit(formData)
  }

  return (
    <form onSubmit={handleSubmit} className={styles.form}>
      <h2>{provider ? t('providers.editProvider') : t('providers.addProvider')}</h2>
      <div className={styles.field}>
        <label htmlFor="name">{t('providers.name')}</label>
        <input
          id="name"
          type="text"
          value={formData.name}
          onChange={(e) => setFormData({ ...formData, name: e.target.value })}
          required
        />
      </div>
      <div className={styles.field}>
        <label htmlFor="type">{t('providers.type')}</label>
        <select
          id="type"
          value={formData.type}
          onChange={(e) => setFormData({ ...formData, type: e.target.value })}
        >
          <option value="openai">OpenAI</option>
          <option value="anthropic">Anthropic</option>
          <option value="google">Google</option>
          <option value="openrouter">OpenRouter</option>
          <option value="custom">Custom</option>
        </select>
      </div>
      <div className={styles.field}>
        <label htmlFor="apiKey">{t('providers.apiKey')}</label>
        <input
          id="apiKey"
          type="password"
          value={formData.apiKey}
          onChange={(e) => setFormData({ ...formData, apiKey: e.target.value })}
        />
      </div>
      <div className={styles.field}>
        <label htmlFor="baseUrl">{t('providers.baseUrl')}</label>
        <input
          id="baseUrl"
          type="text"
          value={formData.baseUrl}
          onChange={(e) => setFormData({ ...formData, baseUrl: e.target.value })}
        />
      </div>
      <div className={styles.field}>
        <label htmlFor="description">{t('providers.description')}</label>
        <textarea
          id="description"
          value={formData.description}
          onChange={(e) => setFormData({ ...formData, description: e.target.value })}
        />
      </div>
      <div className={styles.actions}>
        <button type="submit" className={styles.submitButton}>
          {provider ? t('providers.update') : t('providers.add')}
        </button>
        <button type="button" onClick={onCancel} className={styles.cancelButton}>
          {t('providers.cancel')}
        </button>
      </div>
    </form>
  )
}
