import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useProviderStore } from '@/stores/providerStore'
import styles from '../settings.module.scss'

export function ProviderSection(): React.JSX.Element {
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

  useEffect(() => {
    fetchProviders()
  }, [fetchProviders])

  const handleTest = async (id: string): Promise<void> => {
    const result = await testProvider(id)
    if (result.success) {
      alert(t('settings.providerTestSuccess'))
    } else {
      alert(t('settings.providerTestFailed'))
    }
  }

  return (
    <div className={styles.section}>
      <h2>{t('settings.providers')}</h2>
      {error && <div className={styles.error}>{error}</div>}
      {loading ? (
        <div className={styles.loading}>{t('settings.loading')}</div>
      ) : (
        <div className={styles.providerList}>
          {providers.map((provider) => (
            <div key={provider.id} className={styles.providerItem}>
              <div className={styles.providerInfo}>
                <h3>{provider.name}</h3>
                <p>{provider.type}</p>
              </div>
              <div className={styles.providerActions}>
                <button
                  onClick={() => handleTest(provider.id)}
                  className={styles.testButton}
                >
                  {t('settings.test')}
                </button>
                <button
                  onClick={() => removeProvider(provider.id)}
                  className={styles.removeButton}
                >
                  {t('settings.remove')}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
