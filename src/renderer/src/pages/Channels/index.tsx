import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { ListPanel } from '@/components/ListPanel'
import { useChannelStore } from '@/stores/channelStore'
import { channelsAPI } from '@/services/agent/channels'
import styles from './channels.module.scss'

export default function ChannelsPage(): React.JSX.Element {
  const { t } = useTranslation()
  const { channels, setChannels } = useChannelStore()

  useEffect(() => {
    channelsAPI
      .list()
      .then((data) => setChannels(data.channels ?? data))
      .catch(() => {})
  }, [setChannels])

  const online = channels.filter((c) => c.running)
  const offline = channels.filter((c) => !c.running)

  return (
    <div className={styles.page}>
      <ListPanel visible={true}>
        <div className={styles.list}>
          <div className={styles.panelHeader}>
            <span>Automation</span>
            <strong>{t('channels.title')}</strong>
          </div>
          {online.length > 0 && (
            <div className={styles.group}>
              <h3 className={styles.groupTitle}>{t('channels.online')}</h3>
              {online.map((c) => (
                <div key={c.name} className={styles.card}>
                  <span className={`${styles.dot} ${styles.online}`} />
                  <span className={styles.name}>{c.name}</span>
                </div>
              ))}
            </div>
          )}
          {offline.length > 0 && (
            <div className={styles.group}>
              <h3 className={styles.groupTitle}>{t('channels.offline')}</h3>
              {offline.map((c) => (
                <div key={c.name} className={styles.card}>
                  <span className={styles.dot} />
                  <span className={styles.name}>{c.name}</span>
                  <span className={styles.status}>
                    {c.enabled ? t('channels.enabled') : t('channels.disabled')}
                  </span>
                </div>
              ))}
            </div>
          )}
          {channels.length === 0 && (
            <div className={styles.empty}>{t('channels.empty')}</div>
          )}
        </div>
      </ListPanel>

      <div className={styles.detail}>
        <div className={styles.empty}>{t('channels.pickOne')}</div>
      </div>
    </div>
  )
}
