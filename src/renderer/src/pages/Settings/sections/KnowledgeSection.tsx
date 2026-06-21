import { useEffect, useRef, useState } from 'react'
import { knowledgeAPI } from '@/services/agent/knowledge'

interface DocItem {
  path: string
  size?: number
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
    const files = e.target.files
    if (!files?.length) return
    for (let i = 0; i < files.length; i++) {
      await knowledgeAPI.upload(files[i])
    }
    e.target.value = ''
    await refresh()
  }

  const handleDelete = async (path: string): Promise<void> => {
    await knowledgeAPI.deleteDocument(path)
    await refresh()
  }

  const handleRebuild = async (): Promise<void> => {
    await knowledgeAPI.rebuild()
    await refresh()
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
        <input ref={fileInputRef} type="file" multiple hidden onChange={handleFileChange} />
        <button onClick={handleUpload} style={{ padding: '8px 16px', cursor: 'pointer' }}>
          上传文档
        </button>
        <button onClick={handleRebuild} style={{ padding: '8px 16px', cursor: 'pointer' }}>
          重建索引
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
              style={{
                fontSize: 12,
                color: 'var(--text-tertiary)',
                background: 'none',
                border: 'none',
                cursor: 'pointer'
              }}
            >
              删除
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
