import { useEffect, useRef, useState } from 'react'
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
      toast.error(`已忽略不支持的文件：${rejected.map((f) => f.name).join('、')}`)
    }
    if (!allowed.length) return

    setUploading(true)
    // 并行上传, 单个失败不阻断其余, 收集失败项统一提示
    const results = await Promise.allSettled(allowed.map((f) => knowledgeAPI.upload(f)))
    const failed = allowed.filter((_, i) => results[i].status === 'rejected')
    const okCount = allowed.length - failed.length
    if (okCount > 0) toast.success(`成功上传 ${okCount} 个文档`)
    if (failed.length) toast.error(`${failed.length} 个文档上传失败：${failed.map((f) => f.name).join('、')}`)
    try {
      await refresh()
    } catch {
      // 刷新失败不影响上传结果提示
    }
    setUploading(false)
  }

  const handleDelete = async (path: string): Promise<void> => {
    if (deletingPath) return
    if (!window.confirm(`确定删除文档「${path}」？删除后需重建索引才能生效。`)) return
    setDeletingPath(path)
    try {
      await knowledgeAPI.deleteDocument(path)
      await refresh()
      toast.success('文档已删除')
    } catch (e) {
      toast.error(`删除失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setDeletingPath('')
    }
  }

  const handleRebuild = async (): Promise<void> => {
    if (rebuilding) return
    if (!window.confirm('确定重建索引？该操作可能耗时较长。')) return
    setRebuilding(true)
    try {
      await knowledgeAPI.rebuild()
      await refresh()
      toast.success('索引已重建')
    } catch (e) {
      toast.error(`重建失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setRebuilding(false)
    }
  }

  return (
    <div>
      <h2 style={{ marginBottom: 24 }}>我的文档</h2>
      {status && (
        <p style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 16 }}>
          已索引: {status.indexed} / {status.total}
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
          {uploading ? '上传中…' : '上传文档'}
        </button>
        <button
          onClick={handleRebuild}
          disabled={rebuilding}
          style={{ padding: '8px 16px', cursor: rebuilding ? 'default' : 'pointer' }}
        >
          {rebuilding ? '重建中…' : '重建索引'}
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
              {deletingPath === d.path ? '删除中…' : '删除'}
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
