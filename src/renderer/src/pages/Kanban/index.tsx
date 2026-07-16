import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useKanbanStore } from '@/stores/kanbanStore'
import type { KanbanTask, KanbanStatus, KanbanPriority } from '@shared/kanban-types'
import TaskList from './TaskList'
import TaskForm from './TaskForm'
import styles from './kanban.module.scss'

export default function KanbanPage(): React.JSX.Element {
  const { t } = useTranslation()
  const {
    tasks,
    loading,
    error,
    fetchTasks,
    addTask,
    updateTask,
    deleteTask,
    moveTask
  } = useKanbanStore()

  const [showForm, setShowForm] = useState(false)
  const [editingTask, setEditingTask] = useState<KanbanTask | null>(null)

  useEffect(() => {
    fetchTasks()
  }, [fetchTasks])

  const handleAdd = (): void => {
    setEditingTask(null)
    setShowForm(true)
  }

  const handleEdit = (task: KanbanTask): void => {
    setEditingTask(task)
    setShowForm(true)
  }

  const handleSubmit = async (data: {
    title: string
    description?: string
    status?: KanbanStatus
    priority?: KanbanPriority
    assignee?: string
  }): Promise<void> => {
    if (editingTask) {
      await updateTask({ id: editingTask.id, ...data })
    } else {
      await addTask(data)
    }
    setShowForm(false)
    setEditingTask(null)
  }

  const handleCancel = (): void => {
    setShowForm(false)
    setEditingTask(null)
  }

  const handleMove = async (taskId: string, status: KanbanStatus): Promise<void> => {
    await moveTask(taskId, status)
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h1>{t('kanban.title')}</h1>
        <button onClick={handleAdd} className={styles.addButton}>
          {t('kanban.addTask')}
        </button>
      </div>
      {error && <div className={styles.error}>{error}</div>}
      {loading ? (
        <div className={styles.loading}>{t('kanban.loading')}</div>
      ) : showForm ? (
        <TaskForm
          task={editingTask}
          onSubmit={handleSubmit}
          onCancel={handleCancel}
        />
      ) : (
        <TaskList
          tasks={tasks}
          onEdit={handleEdit}
          onDelete={deleteTask}
          onMove={handleMove}
        />
      )}
    </div>
  )
}
