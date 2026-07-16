import { useTranslation } from 'react-i18next'
import type { ProviderConfig } from '@shared/provider-types'
import styles from './providers.module.scss'

interface ProviderListProps {
  providers: ProviderConfig[]
  onEdit: (provider: ProviderConfig) => void
  onRemove: (id: string) => void
  onTest: (id: string) => void
}

export default function ProviderList({
  providers,
  onEdit,
  onRemove,
  onTest
}: ProviderListProps): React.JSX.Element {
  const { t } = useTranslation()

  if (providers.length === 0) {
    return <div className={styles.empty}>{t('providers.noProviders')}</div>
  }

  return (
    <div className={styles.list}>
      {providers.map((provider) => (
        <div key={provider.id} className={styles.item}>
          <div className={styles.info}>
            <h3>{provider.name}</h3>
            <p>
              {provider.type} &bull; {provider.models.length} {t('providers.models')}
            </p>
          </div>
          <div className={styles.actions}>
            <button onClick={() => onTest(provider.id)} className={styles.testButton}>
              {t('providers.test')}
            </button>
            <button onClick={() => onEdit(provider)} className={styles.editButton}>
              {t('providers.edit')}
            </button>
            <button onClick={() => onRemove(provider.id)} className={styles.removeButton}>
              {t('providers.remove')}
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}
