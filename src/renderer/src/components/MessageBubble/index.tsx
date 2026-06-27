import { StreamRenderer } from '@/components/StreamRenderer'
import type { ChatMessage } from '@/stores/chatStore'
import { clipboard } from '@/utils/clipboard'
import { toast } from '@/components/Toast'
import { useTranslation } from 'react-i18next'
import styles from './bubble.module.scss'
import clsx from 'clsx'

interface MessageBubbleProps {
  message: ChatMessage
  /** 仅最后一条 assistant 消息传入,触发重新生成;不传则不展示该按钮 */
  onRegenerate?: () => void
}

export function MessageBubble({ message, onRegenerate }: MessageBubbleProps): React.JSX.Element {
  const { t } = useTranslation()
  const isUser = message.role === 'user'
  const isSystem = message.role === 'system'

  if (isSystem) {
    return <div className={styles.system}>{message.content}</div>
  }

  const handleCopy = async (): Promise<void> => {
    try {
      await clipboard.writeText(message.content)
      toast.success(t('chat.copied'))
    } catch {
      toast.error(t('chat.copyFailed'))
    }
  }

  // 流式中且正文与过程摘要均为空 = 等待首个增量帧, 显示「思考中」占位提示
  const isThinking = message.isStreaming && !message.content && !message.reasoning

  return (
    <div className={clsx(styles.row, isUser && styles.userRow)}>
      {!isUser && <div className={styles.avatar}>E</div>}
      <div className={styles.messageStack}>
        <span className={styles.role}>{isUser ? 'You' : 'Echo'}</span>
        <div className={clsx(styles.bubble, isUser ? styles.userBubble : styles.assistantBubble)}>
          {isUser ? (
            <>
              {message.attachments && message.attachments.length > 0 && (
                <div className={styles.bubbleAttachments}>
                  {message.attachments.map((att) => (
                    <span key={att.id} className={styles.bubbleAttachment} title={att.name}>
                      <span aria-hidden="true">📎</span>
                      <span className={styles.bubbleAttachmentName}>{att.name}</span>
                    </span>
                  ))}
                </div>
              )}
              {message.content}
            </>
          ) : isThinking ? (
            <div className={styles.thinking}>
              <span className={styles.thinkingDots} aria-hidden="true">
                <span />
                <span />
                <span />
              </span>
              <span>{t('chat.thinking')}</span>
            </div>
          ) : (
            <>
              {message.reasoning && (
                <details className={styles.reasoning} open={message.isStreaming ? true : undefined}>
                  <summary>💭 思考过程</summary>
                  <StreamRenderer content={message.reasoning} />
                </details>
              )}
              <StreamRenderer content={message.content} isStreaming={message.isStreaming} />
            </>
          )}
        </div>
        {!isUser && !message.isStreaming && message.content && (
          <div className={styles.actions}>
            <button className={styles.actionBtn} onClick={handleCopy} title={t('chat.copy')}>
              <CopyIcon />
              <span>{t('chat.copy')}</span>
            </button>
            {onRegenerate && (
              <button
                className={styles.actionBtn}
                onClick={onRegenerate}
                title={t('chat.regenerate')}
              >
                <RegenerateIcon />
                <span>{t('chat.regenerate')}</span>
              </button>
            )}
          </div>
        )}
      </div>
      {isUser && <div className={clsx(styles.avatar, styles.userAvatar)}>Y</div>}
    </div>
  )
}

function CopyIcon(): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  )
}

function RegenerateIcon(): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 2v6h6" />
      <path d="M21 12A9 9 0 0 0 6 5.3L3 8" />
      <path d="M21 22v-6h-6" />
      <path d="M3 12a9 9 0 0 0 15 6.7l3-2.7" />
    </svg>
  )
}
