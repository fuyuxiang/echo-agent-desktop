import { useState, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { buildPptPrompt, type PptOptions } from '@/pages/Chat/pptPrompt'
import { toast } from '@/components/Toast'
import styles from './ppt-composer.module.scss'

const PRESET_COLORS = ['#1F6FEB', '#8E6BF2', '#16A34A', '#DC2626', '#0EA5E9']

interface PptComposerProps {
  disabled: boolean
  onGenerate: (prompt: string) => void
}

export function PptComposer({ disabled, onGenerate }: PptComposerProps): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const [open, setOpen] = useState(false)
  const [topic, setTopic] = useState('')
  const [pages, setPages] = useState(10)
  const [lang, setLang] = useState<'zh' | 'en'>(i18n?.language?.startsWith('en') ? 'en' : 'zh')
  const [themeColor, setThemeColor] = useState(PRESET_COLORS[0])
  const [withImages, setWithImages] = useState(false)
  const [extra, setExtra] = useState('')
  const wrapRef = useRef<HTMLDivElement>(null)

  const submit = useCallback(() => {
    if (!topic.trim()) {
      toast.error(t('chat.ppt.needTopic'))
      return
    }
    const opts: PptOptions = { topic: topic.trim(), pages, lang, themeColor, withImages, extra }
    onGenerate(buildPptPrompt(opts))
    setOpen(false)
    setTopic('')
    setExtra('')
  }, [topic, pages, lang, themeColor, withImages, extra, onGenerate, t])

  return (
    <div className={styles.wrap} ref={wrapRef}>
      <button
        type="button"
        className={styles.trigger}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        aria-label={t('chat.ppt.trigger')}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true">
          <rect x="3" y="4" width="18" height="14" rx="2" fill="none" stroke="currentColor" strokeWidth="1.8" />
          <path d="M7 20h10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
        <span>{t('chat.ppt.trigger')}</span>
      </button>
      {open && (
        <PptPanel
          t={t}
          topic={topic} setTopic={setTopic}
          pages={pages} setPages={setPages}
          lang={lang} setLang={setLang}
          themeColor={themeColor} setThemeColor={setThemeColor}
          withImages={withImages} setWithImages={setWithImages}
          extra={extra} setExtra={setExtra}
          presetColors={PRESET_COLORS}
          onSubmit={submit}
          onCancel={() => setOpen(false)}
        />
      )}
    </div>
  )
}

interface PptPanelProps {
  t: (k: string) => string
  topic: string; setTopic: (v: string) => void
  pages: number; setPages: (v: number) => void
  lang: 'zh' | 'en'; setLang: (v: 'zh' | 'en') => void
  themeColor: string; setThemeColor: (v: string) => void
  withImages: boolean; setWithImages: (v: boolean) => void
  extra: string; setExtra: (v: string) => void
  presetColors: string[]
  onSubmit: () => void
  onCancel: () => void
}

function PptPanel(props: PptPanelProps): React.JSX.Element {
  const { t } = props
  return (
    <div className={styles.panel} role="dialog" aria-modal="false" aria-label={t('chat.ppt.title')}>
      <h4 className={styles.title}>{t('chat.ppt.title')}</h4>

      <label className={styles.field}>
        <span>{t('chat.ppt.topic')}</span>
        <input
          className={styles.input}
          value={props.topic}
          placeholder={t('chat.ppt.topicPlaceholder')}
          onChange={(e) => props.setTopic(e.target.value)}
        />
      </label>

      <label className={styles.field}>
        <span>{t('chat.ppt.pages')}</span>
        <input
          className={styles.input}
          type="number"
          min={5}
          max={30}
          value={props.pages}
          onChange={(e) => props.setPages(Math.min(30, Math.max(5, Number(e.target.value) || 10)))}
        />
      </label>

      <div className={styles.field}>
        <span>{t('chat.ppt.lang')}</span>
        <div className={styles.segmented} role="radiogroup">
          <button type="button" role="radio" aria-checked={props.lang === 'zh'}
            className={props.lang === 'zh' ? styles.segActive : styles.seg}
            onClick={() => props.setLang('zh')}>{t('chat.ppt.langZh')}</button>
          <button type="button" role="radio" aria-checked={props.lang === 'en'}
            className={props.lang === 'en' ? styles.segActive : styles.seg}
            onClick={() => props.setLang('en')}>{t('chat.ppt.langEn')}</button>
        </div>
      </div>

      <div className={styles.field}>
        <span>{t('chat.ppt.themeColor')}</span>
        <div className={styles.colors}>
          {props.presetColors.map((c) => (
            <button key={c} type="button" aria-label={c}
              className={props.themeColor === c ? styles.colorActive : styles.color}
              style={{ background: c }} onClick={() => props.setThemeColor(c)} />
          ))}
        </div>
      </div>

      <label className={styles.checkRow}>
        <input type="checkbox" checked={props.withImages}
          onChange={(e) => props.setWithImages(e.target.checked)} />
        <span>{t('chat.ppt.withImages')}</span>
      </label>

      <label className={styles.field}>
        <span>{t('chat.ppt.extra')}</span>
        <textarea className={styles.textarea} rows={2} value={props.extra}
          placeholder={t('chat.ppt.extraPlaceholder')}
          onChange={(e) => props.setExtra(e.target.value)} />
      </label>

      <div className={styles.actions}>
        <button type="button" className={styles.cancelBtn} onClick={props.onCancel}>{t('chat.ppt.cancel')}</button>
        <button type="button" className={styles.submitBtn} onClick={props.onSubmit}>{t('chat.ppt.generate')}</button>
      </div>
    </div>
  )
}
