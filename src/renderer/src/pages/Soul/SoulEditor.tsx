import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { SoulConfig } from '@shared/soul-types'
import styles from './soul.module.scss'

interface SoulEditorProps {
  soul?: SoulConfig | null
  onSubmit: (data: { name: string; content: string }) => void
  onCancel: () => void
}

export default function SoulEditor({
  soul,
  onSubmit,
  onCancel
}: SoulEditorProps): React.JSX.Element {
  const { t } = useTranslation()
  const [formData, setFormData] = useState({
    name: soul?.name || '',
    content: soul?.content || ''
  })

  const handleSubmit = (e: React.FormEvent): void => {
    e.preventDefault()
    onSubmit(formData)
  }

  return (
    <form onSubmit={handleSubmit} className={styles.form}>
      <h2>{soul ? t('soul.editSoul') : t('soul.addSoul')}</h2>
      <div className={styles.field}>
        <label htmlFor="name">{t('soul.name')}</label>
        <input
          id="name"
          type="text"
          value={formData.name}
          onChange={(e) => setFormData({ ...formData, name: e.target.value })}
          required
        />
      </div>
      <div className={styles.field}>
        <label htmlFor="content">{t('soul.content')}</label>
        <textarea
          id="content"
          value={formData.content}
          onChange={(e) => setFormData({ ...formData, content: e.target.value })}
          className={styles.editor}
          required
        />
      </div>
      <div className={styles.actions}>
        <button type="submit" className={styles.submitButton}>
          {soul ? t('soul.update') : t('soul.add')}
        </button>
        <button type="button" onClick={onCancel} className={styles.cancelButton}>
          {t('soul.cancel')}
        </button>
      </div>
    </form>
  )
}
