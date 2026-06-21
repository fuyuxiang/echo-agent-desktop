import { StreamRenderer } from '@/components/StreamRenderer'
import type { ChatMessage } from '@/stores/chatStore'
import styles from './bubble.module.scss'
import clsx from 'clsx'

interface MessageBubbleProps {
  message: ChatMessage
}

export function MessageBubble({ message }: MessageBubbleProps): React.JSX.Element {
  const isUser = message.role === 'user'
  const isSystem = message.role === 'system'

  if (isSystem) {
    return <div className={styles.system}>{message.content}</div>
  }

  return (
    <div className={clsx(styles.row, isUser && styles.userRow)}>
      {!isUser && <div className={styles.avatar}>E</div>}
      <div className={styles.messageStack}>
        <span className={styles.role}>{isUser ? 'You' : 'Echo'}</span>
        <div className={clsx(styles.bubble, isUser ? styles.userBubble : styles.assistantBubble)}>
          {isUser ? (
            message.content
          ) : (
            <>
              {message.reasoning && (
                <details className={styles.reasoning} open={message.isStreaming ? true : undefined}>
                  <summary>过程摘要</summary>
                  <StreamRenderer content={message.reasoning} />
                </details>
              )}
              <StreamRenderer content={message.content} isStreaming={message.isStreaming} />
            </>
          )}
        </div>
      </div>
      {isUser && <div className={clsx(styles.avatar, styles.userAvatar)}>Y</div>}
    </div>
  )
}
