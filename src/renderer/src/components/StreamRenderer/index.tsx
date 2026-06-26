import { useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { highlightCode } from '@/utils/highlighter'
import { clipboard } from '@/utils/clipboard'
import { toast } from '@/components/Toast'
import { useTranslation } from 'react-i18next'
import styles from './stream.module.scss'

interface StreamRendererProps {
  content: string
  isStreaming?: boolean
}

function getCurrentTheme(): 'light' | 'dark' {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'
}

/**
 * 代码块:流式进行中保持纯文本,完成后异步用 shiki 高亮,避免逐字重渲染卡顿。
 * 右上角展示语言标签 + 复制按钮。
 */
function CodeBlock({
  code,
  lang,
  streaming
}: {
  code: string
  lang: string
  streaming: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const [html, setHtml] = useState<string | null>(null)

  useEffect(() => {
    // 流式进行中不高亮(内容还在变),完成后再高亮一次
    if (streaming) return
    let alive = true
    highlightCode(code, lang, getCurrentTheme()).then((result) => {
      if (alive) setHtml(result)
    })
    return () => {
      alive = false
    }
  }, [code, lang, streaming])

  const handleCopy = async (): Promise<void> => {
    try {
      await clipboard.writeText(code)
      toast.success(t('chat.copied'))
    } catch {
      toast.error(t('chat.copyFailed'))
    }
  }

  return (
    <div className={styles.codeWrap}>
      <div className={styles.codeBar}>
        <span className={styles.codeLang}>{lang || 'text'}</span>
        <button className={styles.codeCopy} onClick={handleCopy} title={t('chat.copy')}>
          {t('chat.copy')}
        </button>
      </div>
      {html && !streaming ? (
        <div className={styles.shiki} dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre className={styles.codeBlock}>
          <code>{code}</code>
        </pre>
      )}
    </div>
  )
}

export function StreamRenderer({ content, isStreaming }: StreamRendererProps): React.JSX.Element {
  return (
    <div className={styles.renderer}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ className, children, ...props }) {
            const match = /language-(\w+)/.exec(className ?? '')
            const isBlock = className?.startsWith('language-')
            if (isBlock) {
              const code = String(children).replace(/\n$/, '')
              return <CodeBlock code={code} lang={match?.[1] ?? ''} streaming={!!isStreaming} />
            }
            return (
              <code className={styles.inlineCode} {...props}>
                {children}
              </code>
            )
          }
        }}
      >
        {content}
      </ReactMarkdown>
      {isStreaming && <span className={styles.cursor} />}
    </div>
  )
}
