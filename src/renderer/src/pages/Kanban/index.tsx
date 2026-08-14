import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useKanbanStore } from '@/stores/kanbanStore'
import { useOrgStore, isOrgReady } from '@/stores/orgStore'
import { PromoteDialog } from '@/components/PromoteDialog'
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
  const [promoteTask, setPromoteTask] = useState<KanbanTask | null>(null)
  const orgStatus = useOrgStore((s) => s.status)
  const initOrg = useOrgStore((s) => s.init)

  useEffect(() => {
    fetchTasks()
    void initOrg()
  }, [fetchTasks, initOrg])

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
    const before = tasks.find((x) => x.id === taskId)
    await moveTask(taskId, status)

    // 任务刚完成时是回顾解法的最佳时机 —— 过几天细节就忘了,再想沉淀也
    // 写不出有用的东西。只在首次进入 done 时提示,反复拖动不重复打扰。
    if (status === 'done' && before && before.status !== 'done' && isOrgReady(orgStatus)) {
      setPromoteTask(before)
    }
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
      {promoteTask && (
        <PromoteDialog
          source="task"
          // 预填任务标题与说明,但类型默认 howto —— 任务沉淀多是"这件事
          // 该怎么做",而非会上定下的决策。
          defaultKind="howto"
          defaultContent={
            promoteTask.description
              ? `${promoteTask.title}:${promoteTask.description}`
              : promoteTask.title
          }
          onClose={() => setPromoteTask(null)}
        />
      )}
    </div>
  )
}
