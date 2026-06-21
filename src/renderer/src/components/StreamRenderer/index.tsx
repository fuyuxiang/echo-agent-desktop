import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import styles from './stream.module.scss'

interface StreamRendererProps {
  content: string
  isStreaming?: boolean
}

export function StreamRenderer({ content, isStreaming }: StreamRendererProps): React.JSX.Element {
  return (
    <div className={styles.renderer}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ className, children, ...props }) {
            const isBlock = className?.startsWith('language-')
            if (isBlock) {
              return (
                <pre className={styles.codeBlock}>
                  <code className={className} {...props}>
                    {children}
                  </code>
                </pre>
              )
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
