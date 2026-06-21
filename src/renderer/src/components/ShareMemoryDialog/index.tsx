import { useTranslation } from 'react-i18next'
import type { MemoryCandidate, ShareDecision } from '@/services/memory-router'
import styles from './share-memory-dialog.module.scss'

interface ShareMemoryDialogProps {
  candidate: MemoryCandidate
  onDecide: (decision: ShareDecision) => void
}

export function ShareMemoryDialog({
  candidate,
  onDecide
}: ShareMemoryDialogProps): React.JSX.Element {
  const { t } = useTranslation()

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-label={t('memory.shareTitle')}>
      <div className={styles.dialog}>
        <h3 className={styles.title}>{t('memory.shareTitle')}</h3>
        <p className={styles.prompt}>{t('memory.sharePrompt')}</p>
        <div className={styles.content}>{candidate.content}</div>
        {candidate.reason && <p className={styles.reason}>{candidate.reason}</p>}
        <div className={styles.actions}>
          <button className={styles.shareBtn} onClick={() => onDecide('share')}>
            {t('memory.share')}
          </button>
          <button className={styles.localBtn} onClick={() => onDecide('local')}>
            {t('memory.localOnly')}
          </button>
          <button className={styles.discardBtn} onClick={() => onDecide('discard')}>
            {t('memory.discard')}
          </button>
        </div>
      </div>
    </div>
  )
}
