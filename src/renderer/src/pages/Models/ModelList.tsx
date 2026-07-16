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
  activeModel,
  onEdit,
  onRemove,
  onSetActive
}: ModelListProps): React.JSX.Element {
  if (models.length === 0) {
    return <div className={styles.empty}>No models configured</div>
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
              {model.provider} • {model.contextWindow.toLocaleString()} tokens
            </p>
          </div>
          <div className={styles.actions}>
            {!model.isActive && (
              <button
                onClick={() => onSetActive(model.id)}
                className={styles.setActiveButton}
              >
                Set Active
              </button>
            )}
            <button onClick={() => onEdit(model)} className={styles.editButton}>
              Edit
            </button>
            <button
              onClick={() => onRemove(model.id)}
              className={styles.removeButton}
            >
              Remove
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}
