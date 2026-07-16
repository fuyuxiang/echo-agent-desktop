import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useGatewayStore } from '@/stores/gatewayStore'
import type { GatewayConfig } from '@shared/gateway-types'
import PlatformList from './PlatformList'
import PlatformForm from './PlatformForm'
import styles from './gateway.module.scss'

export default function GatewayPage(): React.JSX.Element {
  const { t } = useTranslation()
  const {
    platforms,
    configs,
    statuses,
    loading,
    error,
    fetchPlatforms,
    fetchConfigs,
    addConfig,
    updateConfig,
    removeConfig,
    testConnection
  } = useGatewayStore()

  const [showForm, setShowForm] = useState(false)
  const [editingConfig, setEditingConfig] = useState<GatewayConfig | null>(null)

  useEffect(() => {
    fetchPlatforms()
    fetchConfigs()
  }, [fetchPlatforms, fetchConfigs])

  const handleAdd = (): void => {
    setEditingConfig(null)
    setShowForm(true)
  }

  const handleEdit = (config: GatewayConfig): void => {
    setEditingConfig(config)
    setShowForm(true)
  }

  const handleSubmit = async (data: {
    platformId: string
    apiKey?: string
    webhookUrl?: string
  }): Promise<void> => {
    if (editingConfig) {
      await updateConfig({ id: editingConfig.id, ...data })
    } else {
      await addConfig(data)
    }
    setShowForm(false)
    setEditingConfig(null)
  }

  const handleCancel = (): void => {
    setShowForm(false)
    setEditingConfig(null)
  }

  const handleTest = async (platformId: string): Promise<void> => {
    await testConnection(platformId)
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h1>{t('gateway.title')}</h1>
        <button onClick={handleAdd} className={styles.addButton}>
          {t('gateway.addConfig')}
        </button>
      </div>
      {error && <div className={styles.error}>{error}</div>}
      {loading ? (
        <div className={styles.loading}>{t('gateway.loading')}</div>
      ) : showForm ? (
        <PlatformForm
          config={editingConfig}
          platforms={platforms}
          onSubmit={handleSubmit}
          onCancel={handleCancel}
        />
      ) : (
        <PlatformList
          platforms={platforms}
          configs={configs}
          statuses={statuses}
          onEdit={handleEdit}
          onRemove={removeConfig}
          onTest={handleTest}
        />
      )}
    </div>
  )
}
