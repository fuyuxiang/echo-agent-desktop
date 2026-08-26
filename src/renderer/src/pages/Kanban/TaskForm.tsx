import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { KanbanTask, KanbanStatus, KanbanPriority } from '@shared/kanban-types'
import styles from './kanban.module.scss'

interface TaskFormProps {
  task?: KanbanTask | null
  onSubmit: (data: {
    title: string
    description?: string
    status?: KanbanStatus
    priority?: KanbanPriority
    assignee?: string
  }) => void
  onCancel: () => void
}

const EDITABLE_STATUS: Record<KanbanStatus, KanbanStatus[]> = {
  triage: ['triage', 'ready', 'archived'],
  todo: ['todo', 'ready', 'archived'],
  ready: ['ready', 'archived'],
  running: ['running', 'review', 'blocked', 'scheduled', 'archived'],
  blocked: ['blocked', 'ready', 'archived'],
  review: ['review', 'done', 'ready'],
  scheduled: ['scheduled', 'ready', 'archived'],
  done: ['done'],
  archived: ['archived']
}

const STATUS_KEY: Record<KanbanStatus, string> = {
  triage: 'kanban.triage', todo: 'kanban.todo', scheduled: 'kanban.scheduled',
  ready: 'kanban.ready', running: 'kanban.running', blocked: 'kanban.blocked',
  review: 'kanban.review', done: 'kanban.done', archived: 'kanban.archived'
}

export default function TaskForm({
  task,
  onSubmit,
  onCancel
}: TaskFormProps): React.JSX.Element {
  const { t } = useTranslation()
  const [formData, setFormData] = useState({
    title: task?.title || '',
    description: task?.description || '',
    status: task?.status || 'todo' as KanbanStatus,
    priority: task?.priority || 'medium' as KanbanPriority,
    assignee: task?.assignee || ''
  })
  const availableStatuses = task ? EDITABLE_STATUS[task.status] : ['todo', 'ready'] as KanbanStatus[]

  const handleSubmit = (e: React.FormEvent): void => {
    e.preventDefault()
    onSubmit(formData)
  }

  return (
    <form onSubmit={handleSubmit} className={styles.form}>
      <h2>{task ? t('kanban.editTask') : t('kanban.addTask')}</h2>
      <div className={styles.field}>
        <label htmlFor="title">{t('kanban.title')}</label>
        <input
          id="title"
          type="text"
          value={formData.title}
          onChange={(e) => setFormData({ ...formData, title: e.target.value })}
          required
        />
      </div>
      <div className={styles.field}>
        <label htmlFor="description">{t('kanban.description')}</label>
        <textarea
          id="description"
          value={formData.description}
          onChange={(e) =>
            setFormData({ ...formData, description: e.target.value })
          }
        />
      </div>
      <div className={styles.field}>
        <label htmlFor="status">{t('kanban.status')}</label>
        <select
          id="status"
          value={formData.status}
          onChange={(e) =>
            setFormData({ ...formData, status: e.target.value as KanbanStatus })
          }
        >
          {availableStatuses.map((status) => (
            <option key={status} value={status}>{t(STATUS_KEY[status])}</option>
          ))}
        </select>
      </div>
      <div className={styles.field}>
        <label htmlFor="priority">{t('kanban.priority')}</label>
        <select
          id="priority"
          value={formData.priority}
          onChange={(e) =>
            setFormData({
              ...formData,
              priority: e.target.value as KanbanPriority
            })
          }
        >
          <option value="low">{t('kanban.priority.low')}</option>
          <option value="medium">{t('kanban.priority.medium')}</option>
          <option value="high">{t('kanban.priority.high')}</option>
          <option value="critical">{t('kanban.priority.critical')}</option>
        </select>
      </div>
      <div className={styles.field}>
        <label htmlFor="assignee">{t('kanban.assignee')}</label>
        <input
          id="assignee"
          type="text"
          value={formData.assignee}
          onChange={(e) =>
            setFormData({ ...formData, assignee: e.target.value })
          }
        />
      </div>
      <div className={styles.actions}>
        <button type="submit" className={styles.submitButton}>
          {task ? t('kanban.update') : t('kanban.add')}
        </button>
        <button type="button" onClick={onCancel} className={styles.cancelButton}>
          {t('kanban.cancel')}
        </button>
      </div>
    </form>
  )
}
