import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useProviderStore } from '@/stores/providerStore'
import type { ProviderConfig, ProviderAddRequest, ProviderUpdateRequest } from '@shared/provider-types'
import ProviderList from './ProviderList'
import ProviderForm from './ProviderForm'
import styles from './providers.module.scss'

export default function ProvidersPage(): React.JSX.Element {
  const { t } = useTranslation()
  const {
    providers,
    loading,
    error,
    fetchProviders,
    addProvider,
    updateProvider,
    removeProvider,
    testProvider
  } = useProviderStore()

  const [showForm, setShowForm] = useState(false)
  const [editingProvider, setEditingProvider] = useState<ProviderConfig | null>(null)

  useEffect(() => {
    fetchProviders()
  }, [fetchProviders])

  const handleAdd = (): void => {
    setEditingProvider(null)
    setShowForm(true)
  }

  const handleEdit = (provider: ProviderConfig): void => {
    setEditingProvider(provider)
    setShowForm(true)
  }

  const handleSubmit = async (data: ProviderAddRequest): Promise<void> => {
    if (editingProvider) {
      await updateProvider({ id: editingProvider.id, ...data } as ProviderUpdateRequest)
    } else {
      await addProvider(data)
    }
    setShowForm(false)
    setEditingProvider(null)
  }

  const handleCancel = (): void => {
    setShowForm(false)
    setEditingProvider(null)
  }

  const handleTest = async (id: string): Promise<void> => {
    const result = await testProvider(id)
    // eslint-disable-next-line no-alert
    alert(result.success ? t('providers.testSuccess') : t('providers.testFailed', { message: result.message }))
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h1>{t('providers.title')}</h1>
        <button onClick={handleAdd} className={styles.addButton}>
          {t('providers.addProvider')}
        </button>
      </div>
      {error && <div className={styles.error}>{error}</div>}
      {loading ? (
        <div className={styles.loading}>{t('providers.loading')}</div>
      ) : showForm ? (
        <ProviderForm
          provider={editingProvider}
          onSubmit={handleSubmit}
          onCancel={handleCancel}
        />
      ) : (
        <ProviderList
          providers={providers}
          onEdit={handleEdit}
          onRemove={removeProvider}
          onTest={handleTest}
        />
      )}
    </div>
  )
}
