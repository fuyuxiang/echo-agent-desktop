import { useTranslation } from 'react-i18next'
import type { KanbanTask, KanbanStatus } from '@shared/kanban-types'
import styles from './kanban.module.scss'

interface TaskListProps {
  tasks: KanbanTask[]
  onEdit: (task: KanbanTask) => void
  onDelete: (id: string) => void
  onMove: (taskId: string, status: KanbanStatus) => void
}

const KANBAN_COLUMNS: { status: KanbanStatus; label: string }[] = [
  { status: 'triage', label: 'kanban.triage' },
  { status: 'todo', label: 'kanban.todo' },
  { status: 'scheduled', label: 'kanban.scheduled' },
  { status: 'ready', label: 'kanban.ready' },
  { status: 'running', label: 'kanban.running' },
  { status: 'blocked', label: 'kanban.blocked' },
  { status: 'review', label: 'kanban.review' },
  { status: 'done', label: 'kanban.done' },
  { status: 'archived', label: 'kanban.archived' }
]

export default function TaskList({
  tasks,
  onEdit,
  onDelete,
  onMove
}: TaskListProps): React.JSX.Element {
  const { t } = useTranslation()

  const getTasksByStatus = (status: KanbanStatus): KanbanTask[] => {
    return tasks.filter((task) => task.status === status)
  }

  if (tasks.length === 0) {
    return <div className={styles.empty}>{t('kanban.noTasks')}</div>
  }

  return (
    <div className={styles.board}>
      {KANBAN_COLUMNS.map((column) => {
        const columnTasks = getTasksByStatus(column.status)

        return (
          <div key={column.status} className={styles.column}>
            <div className={styles.columnHeader}>
              <h3>{t(column.label)}</h3>
              <span className={styles.taskCount}>{columnTasks.length}</span>
            </div>
            <div className={styles.columnContent}>
              {columnTasks.map((task) => (
                <div key={task.id} className={styles.taskCard}>
                  <div className={styles.taskHeader}>
                    <h4>{task.title}</h4>
                    <span
                      className={`${styles.priority} ${styles[task.priority]}`}
                    >
                      {t(`kanban.priority.${task.priority}`)}
                    </span>
                  </div>
                  {task.description && (
                    <p className={styles.taskDescription}>{task.description}</p>
                  )}
                  {task.assignee && (
                    <div className={styles.assignee}>
                      {t('kanban.assignee')}: {task.assignee}
                    </div>
                  )}
                  <div className={styles.taskActions}>
                    <button
                      onClick={() => onEdit(task)}
                      className={styles.editButton}
                    >
                      {t('kanban.edit')}
                    </button>
                    <button
                      onClick={() => onDelete(task.id)}
                      className={styles.deleteButton}
                    >
                      {t('kanban.delete')}
                    </button>
                    <select
                      value={task.status}
                      onChange={(e) => onMove(task.id, e.target.value as KanbanStatus)}
                      className={styles.statusSelect}
                    >
                      {KANBAN_COLUMNS.map((col) => (
                        <option key={col.status} value={col.status}>
                          {t(col.label)}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}
