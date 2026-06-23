import { useTranslation } from 'react-i18next'
import { useMeetingStore } from '@/stores/meetingStore'
import styles from './meeting-button.module.scss'

interface Props {
  disabled: boolean
  onStart: () => void
}

export function MeetingButton({ disabled, onStart }: Props): React.JSX.Element {
  const { t } = useTranslation()
  const recording = useMeetingStore((s) => s.recording)
  return (
    <button
      type="button"
      className={`${styles.trigger} ${recording ? styles.active : ''}`}
      disabled={disabled}
      onClick={onStart}
      aria-label={t('chat.meeting.trigger')}
    >
      <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M12 14a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
        />
        <path
          d="M5 11a7 7 0 0 0 14 0M12 18v3"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      </svg>
      <span>{recording ? t('chat.meeting.recording') : t('chat.meeting.trigger')}</span>
    </button>
  )
}
