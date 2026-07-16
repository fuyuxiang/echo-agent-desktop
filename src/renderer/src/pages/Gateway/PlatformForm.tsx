import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { GatewayConfig, GatewayPlatform } from '@shared/gateway-types'
import styles from './gateway.module.scss'

interface PlatformFormProps {
  config?: GatewayConfig | null
  platforms: GatewayPlatform[]
  onSubmit: (data: {
    platformId: string
    apiKey?: string
    webhookUrl?: string
  }) => void
  onCancel: () => void
}

export default function PlatformForm({
  config,
  platforms,
  onSubmit,
  onCancel
}: PlatformFormProps): React.JSX.Element {
  const { t } = useTranslation()
  const [formData, setFormData] = useState({
    platformId: config?.platformId || '',
    apiKey: config?.apiKey || '',
    webhookUrl: config?.webhookUrl || ''
  })

  const handleSubmit = (e: React.FormEvent): void => {
    e.preventDefault()
    onSubmit(formData)
  }

  return (
    <form onSubmit={handleSubmit} className={styles.form}>
      <h2>{config?.id ? t('gateway.editConfig') : t('gateway.addConfig')}</h2>
      <div className={styles.field}>
        <label htmlFor="platformId">{t('gateway.platform')}</label>
        <select
          id="platformId"
          value={formData.platformId}
          onChange={(e) => setFormData({ ...formData, platformId: e.target.value })}
          required
        >
          <option value="">{t('gateway.selectPlatform')}</option>
          {platforms.map((platform) => (
            <option key={platform.id} value={platform.id}>
              {platform.name}
            </option>
          ))}
        </select>
      </div>
      <div className={styles.field}>
        <label htmlFor="apiKey">{t('gateway.apiKey')}</label>
        <input
          id="apiKey"
          type="password"
          value={formData.apiKey}
          onChange={(e) => setFormData({ ...formData, apiKey: e.target.value })}
        />
      </div>
      <div className={styles.field}>
        <label htmlFor="webhookUrl">{t('gateway.webhookUrl')}</label>
        <input
          id="webhookUrl"
          type="url"
          value={formData.webhookUrl}
          onChange={(e) => setFormData({ ...formData, webhookUrl: e.target.value })}
        />
      </div>
      <div className={styles.actions}>
        <button type="submit" className={styles.submitButton}>
          {config?.id ? t('gateway.update') : t('gateway.add')}
        </button>
        <button type="button" onClick={onCancel} className={styles.cancelButton}>
          {t('gateway.cancel')}
        </button>
      </div>
    </form>
  )
}
