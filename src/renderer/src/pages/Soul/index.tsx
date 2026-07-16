import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSoulStore } from '@/stores/soulStore'
import type { SoulConfig } from '@shared/soul-types'
import SoulEditor from './SoulEditor'
import styles from './soul.module.scss'

export default function SoulPage(): React.JSX.Element {
  const { t } = useTranslation()
  const {
    souls,
    loading,
    error,
    fetchSouls,
    addSoul,
    updateSoul,
    deleteSoul,
    setActiveSoul
  } = useSoulStore()

  const [showEditor, setShowEditor] = useState(false)
  const [editingSoul, setEditingSoul] = useState<SoulConfig | null>(null)

  useEffect(() => {
    fetchSouls()
  }, [fetchSouls])

  const handleAdd = (): void => {
    setEditingSoul(null)
    setShowEditor(true)
  }

  const handleEdit = (soul: SoulConfig): void => {
    setEditingSoul(soul)
    setShowEditor(true)
  }

  const handleSubmit = async (data: {
    name: string
    content: string
  }): Promise<void> => {
    if (editingSoul) {
      await updateSoul({ id: editingSoul.id, ...data })
    } else {
      await addSoul(data)
    }
    setShowEditor(false)
    setEditingSoul(null)
  }

  const handleCancel = (): void => {
    setShowEditor(false)
    setEditingSoul(null)
  }

  const handleSetActive = async (id: string): Promise<void> => {
    await setActiveSoul(id)
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h1>{t('soul.title')}</h1>
        <button onClick={handleAdd} className={styles.addButton}>
          {t('soul.addSoul')}
        </button>
      </div>
      {error && <div className={styles.error}>{error}</div>}
      {loading ? (
        <div className={styles.loading}>{t('soul.loading')}</div>
      ) : showEditor ? (
        <SoulEditor
          soul={editingSoul}
          onSubmit={handleSubmit}
          onCancel={handleCancel}
        />
      ) : (
        <div className={styles.soulList}>
          {souls.length === 0 ? (
            <div className={styles.empty}>{t('soul.noSouls')}</div>
          ) : (
            souls.map((soul) => (
              <div
                key={soul.id}
                className={`${styles.soulItem} ${soul.isActive ? styles.active : ''}`}
              >
                <div className={styles.soulInfo}>
                  <h3>{soul.name}</h3>
                  <p className={styles.soulPreview}>
                    {soul.content.substring(0, 100)}...
                  </p>
                </div>
                <div className={styles.soulActions}>
                  {!soul.isActive && (
                    <button
                      onClick={() => handleSetActive(soul.id)}
                      className={styles.setActiveButton}
                    >
                      {t('soul.setActive')}
                    </button>
                  )}
                  <button
                    onClick={() => handleEdit(soul)}
                    className={styles.editButton}
                  >
                    {t('soul.edit')}
                  </button>
                  <button
                    onClick={() => deleteSoul(soul.id)}
                    className={styles.removeButton}
                  >
                    {t('soul.remove')}
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}
