import { useTranslation } from 'react-i18next'
import type { ModelConfig } from '@shared/model-types'
import styles from './models.module.scss'

interface ModelListProps {
  models: ModelConfig[]
  activeModel: ModelConfig | null
  onEdit: (model: ModelConfig) => void
  onRemove: (id: string) => void
  onSetActive: (id: string) => void
}

export default function ModelList({
  models,
  onEdit,
  onRemove,
  onSetActive
}: ModelListProps): React.JSX.Element {
  const { t } = useTranslation()
  if (models.length === 0) {
    return <div className={styles.empty}>{t('models.noModels')}</div>
  }

  return (
    <div className={styles.list}>
      {models.map((model) => (
        <div
          key={model.id}
          className={`${styles.item} ${model.isActive ? styles.active : ''}`}
        >
          <div className={styles.info}>
            <h3>{model.name}</h3>
            <p>
              {model.provider} • {model.contextWindow.toLocaleString()} {t('models.tokens')}
            </p>
          </div>
          <div className={styles.actions}>
            {!model.isActive && (
              <button
                onClick={() => onSetActive(model.id)}
                className={styles.setActiveButton}
              >
                {t('models.setActive')}
              </button>
            )}
            <button onClick={() => onEdit(model)} className={styles.editButton}>
              {t('models.edit')}
            </button>
            <button
              onClick={() => onRemove(model.id)}
              className={styles.removeButton}
            >
              {t('models.remove')}
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}
