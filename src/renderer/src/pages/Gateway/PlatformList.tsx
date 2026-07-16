import { useTranslation } from 'react-i18next'
import type { GatewayPlatform, GatewayConfig, GatewayStatus } from '@shared/gateway-types'
import styles from './gateway.module.scss'

interface PlatformListProps {
  platforms: GatewayPlatform[]
  configs: GatewayConfig[]
  statuses: GatewayStatus[]
  onEdit: (config: GatewayConfig) => void
  onRemove: (id: string) => void
  onTest: (platformId: string) => void
}

export default function PlatformList({
  platforms,
  configs,
  statuses,
  onEdit,
  onRemove,
  onTest
}: PlatformListProps): React.JSX.Element {
  const { t } = useTranslation()

  const getConfigForPlatform = (platformId: string): GatewayConfig | undefined => {
    return configs.find((c) => c.platformId === platformId)
  }

  const getStatusForPlatform = (platformId: string): GatewayStatus | undefined => {
    return statuses.find((s) => s.platformId === platformId)
  }

  if (platforms.length === 0) {
    return <div className={styles.empty}>{t('gateway.noPlatforms')}</div>
  }

  return (
    <div className={styles.list}>
      {platforms.map((platform) => {
        const config = getConfigForPlatform(platform.id)
        const status = getStatusForPlatform(platform.id)

        return (
          <div key={platform.id} className={styles.item}>
            <div className={styles.info}>
              <h3>{platform.name}</h3>
              <p>{platform.description || platform.type}</p>
              {status && (
                <span
                  className={`${styles.status} ${status.isConnected ? styles.connected : styles.disconnected}`}
                >
                  {status.isConnected ? t('gateway.connected') : t('gateway.disconnected')}
                </span>
              )}
            </div>
            <div className={styles.actions}>
              <button
                onClick={() => onTest(platform.id)}
                className={styles.testButton}
              >
                {t('gateway.test')}
              </button>
              {config ? (
                <>
                  <button
                    onClick={() => onEdit(config)}
                    className={styles.editButton}
                  >
                    {t('gateway.edit')}
                  </button>
                  <button
                    onClick={() => onRemove(config.id)}
                    className={styles.removeButton}
                  >
                    {t('gateway.remove')}
                  </button>
                </>
              ) : (
                <button
                  onClick={() =>
                    onEdit({
                      id: '',
                      platformId: platform.id,
                      isActive: true,
                      createdAt: '',
                      updatedAt: ''
                    })
                  }
                  className={styles.addButton}
                >
                  {t('gateway.configure')}
                </button>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
