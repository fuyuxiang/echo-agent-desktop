import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useModelStore } from '@/stores/modelStore'
import type { ModelConfig } from '@shared/model-types'
import ModelList from './ModelList'
import ModelForm from './ModelForm'
import styles from './models.module.scss'

export default function ModelsPage(): React.JSX.Element {
  const { t } = useTranslation()
  const {
    models,
    activeModel,
    loading,
    error,
    fetchModels,
    addModel,
    updateModel,
    removeModel,
    setActiveModel
  } = useModelStore()

  const [showForm, setShowForm] = useState(false)
  const [editingModel, setEditingModel] = useState<ModelConfig | null>(null)

  useEffect(() => {
    fetchModels()
  }, [fetchModels])

  const handleAdd = (): void => {
    setEditingModel(null)
    setShowForm(true)
  }

  const handleEdit = (model: ModelConfig): void => {
    setEditingModel(model)
    setShowForm(true)
  }

  const handleSubmit = async (data: {
    name: string
    provider: string
    contextWindow: number
    maxTokens: number
  }): Promise<void> => {
    if (editingModel) {
      await updateModel({ id: editingModel.id, ...data })
    } else {
      await addModel(data)
    }
    setShowForm(false)
    setEditingModel(null)
  }

  const handleCancel = (): void => {
    setShowForm(false)
    setEditingModel(null)
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h1>{t('models.title')}</h1>
        <button onClick={handleAdd} className={styles.addButton}>
          {t('models.addModel')}
        </button>
      </div>
      {error && <div className={styles.error}>{error}</div>}
      {loading ? (
        <div className={styles.loading}>{t('models.loading')}</div>
      ) : showForm ? (
        <ModelForm
          model={editingModel}
          onSubmit={handleSubmit}
          onCancel={handleCancel}
        />
      ) : (
        <ModelList
          models={models}
          activeModel={activeModel}
          onEdit={handleEdit}
          onRemove={removeModel}
          onSetActive={setActiveModel}
        />
      )}
    </div>
  )
}
