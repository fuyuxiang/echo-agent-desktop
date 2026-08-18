import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { knowledgeAPI } from '@/services/agent/knowledge'
import { toast } from '@/components/Toast'

interface DocItem {
  path: string
  size?: number
}

/** 允许上传的文档扩展名 */
const ACCEPT_EXT = ['.txt', '.md', '.markdown', '.pdf', '.doc', '.docx', '.csv', '.json']
const ACCEPT_ATTR = ACCEPT_EXT.join(',')

function isAllowedFile(name: string): boolean {
  const lower = name.toLowerCase()
  return ACCEPT_EXT.some((ext) => lower.endsWith(ext))
}

async function fetchKnowledge(): Promise<{
  docs: DocItem[]
  status: { indexed: number; total: number }
}> {
  const [docData, statusData] = await Promise.all([
    knowledgeAPI.listDocuments(),
    knowledgeAPI.getStatus()
  ])
  return { docs: docData.documents ?? [], status: statusData }
}

export function KnowledgeSection(): React.JSX.Element {
  const { t } = useTranslation()
  const [docs, setDocs] = useState<DocItem[]>([])
  const [status, setStatus] = useState<{ indexed: number; total: number } | null>(null)
  const [uploading, setUploading] = useState(false)
  const [rebuilding, setRebuilding] = useState(false)
  const [deletingPath, setDeletingPath] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  const refresh = async (): Promise<void> => {
    const data = await fetchKnowledge()
    setDocs(data.docs)
    setStatus(data.status)
  }

  useEffect(() => {
    fetchKnowledge()
      .then((data) => {
        setDocs(data.docs)
        setStatus(data.status)
      })
      .catch(() => {})
  }, [])

  const handleUpload = (): void => {
    fileInputRef.current?.click()
  }

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const fileList = e.target.files
    if (!fileList?.length) return
    const files = Array.from(fileList)
    e.target.value = ''

    // 类型校验: 过滤不支持的扩展名
    const allowed = files.filter((f) => isAllowedFile(f.name))
    const rejected = files.filter((f) => !isAllowedFile(f.name))
    if (rejected.length) {
      toast.error(
        t('knowledge.rejected', {
          names: rejected.map((f) => f.name).join(t('common.listJoiner', '、'))
        })
      )
    }
    if (!allowed.length) return

    setUploading(true)
    // 并行上传, 单个失败不阻断其余, 收集失败项统一提示
    const results = await Promise.allSettled(allowed.map((f) => knowledgeAPI.upload(f)))
    const failed = allowed.filter((_, i) => results[i].status === 'rejected')
    const okCount = allowed.length - failed.length
    if (okCount > 0) toast.success(t('knowledge.uploaded', { count: okCount }))
    if (failed.length) {
      toast.error(
        t('knowledge.uploadFailed', {
          count: failed.length,
          names: failed.map((f) => f.name).join(t('common.listJoiner', '、'))
        })
      )
    }
    try {
      await refresh()
    } catch {
      // 刷新失败不影响上传结果提示
    }
    setUploading(false)
  }

  const handleDelete = async (path: string): Promise<void> => {
    if (deletingPath) return
    if (!window.confirm(t('knowledge.deleteConfirm', { path }))) return
    setDeletingPath(path)
    try {
      await knowledgeAPI.deleteDocument(path)
      await refresh()
      toast.success(t('knowledge.deleted'))
    } catch (e) {
      toast.error(
        t('knowledge.deleteFailed', { message: (e as Error).message })
      )
    } finally {
      setDeletingPath('')
    }
  }

  const handleRebuild = async (): Promise<void> => {
    if (rebuilding) return
    if (!window.confirm(t('knowledge.rebuildConfirm'))) return
    setRebuilding(true)
    try {
      await knowledgeAPI.rebuild()
      await refresh()
      toast.success(t('knowledge.rebuilt'))
    } catch (e) {
      toast.error(t('knowledge.rebuildFailed', { message: (e as Error).message }))
    } finally {
      setRebuilding(false)
    }
  }

  return (
    <div>
      <h2 style={{ marginBottom: 24 }}>{t('knowledge.title')}</h2>
      {status && (
        <p style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 16 }}>
          {t('knowledge.indexed', { indexed: status.indexed, total: status.total })}
        </p>
      )}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          accept={ACCEPT_ATTR}
          onChange={handleFileChange}
        />
        <button
          onClick={handleUpload}
          disabled={uploading}
          style={{ padding: '8px 16px', cursor: uploading ? 'default' : 'pointer' }}
        >
          {uploading ? t('knowledge.uploading') : t('knowledge.upload')}
        </button>
        <button
          onClick={handleRebuild}
          disabled={rebuilding}
          style={{ padding: '8px 16px', cursor: rebuilding ? 'default' : 'pointer' }}
        >
          {rebuilding ? t('knowledge.rebuilding') : t('knowledge.rebuild')}
        </button>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {docs.map((d) => (
          <div
            key={d.path}
            style={{
              padding: 12,
              background: 'var(--bg-secondary)',
              borderRadius: 8,
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center'
            }}
          >
            <span style={{ fontSize: 13 }}>{d.path}</span>
            <button
              onClick={() => handleDelete(d.path)}
              disabled={deletingPath === d.path}
              style={{
                fontSize: 12,
                color: 'var(--text-tertiary)',
                background: 'none',
                border: 'none',
                cursor: deletingPath === d.path ? 'default' : 'pointer'
              }}
            >
              {deletingPath === d.path ? t('knowledge.deleting') : t('knowledge.delete')}
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
