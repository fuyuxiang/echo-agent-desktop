import { useEffect, useState, useCallback } from 'react'
import { useMemoryStore } from '@/stores/memoryStore'
import { memoryAPI } from '@/services/agent/memory'

export function MemorySection(): React.JSX.Element {
  const { entries, total, setEntries } = useMemoryStore()
  const [query, setQuery] = useState('')

  const loadEntries = useCallback(() => {
    memoryAPI
      .list({ limit: 50 })
      .then((data) => setEntries(data.entries ?? [], data.total ?? 0))
      .catch(() => {})
  }, [setEntries])

  useEffect(() => {
    loadEntries()
  }, [loadEntries])

  const handleSearch = async (): Promise<void> => {
    if (!query.trim()) return
    const data = await memoryAPI.search(query)
    setEntries(
      data.results?.map(
        (r: {
          entry: {
            id: string
            content: string
            type: string
            tier: string
            tags: string[]
            created_at: string
            updated_at: string
          }
        }) => r.entry
      ) ?? [],
      data.results?.length ?? 0
    )
  }

  const handleDelete = async (id: string): Promise<void> => {
    await memoryAPI.delete(id)
    loadEntries()
  }

  return (
    <div>
      <h2 style={{ marginBottom: 24 }}>记忆管理</h2>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索记忆..."
          style={{ flex: 1, padding: '8px' }}
          onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
        />
        <button onClick={handleSearch} style={{ padding: '8px 16px', cursor: 'pointer' }}>
          搜索
        </button>
      </div>
      <p style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 16 }}>
        共 {total} 条记忆
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {entries.map((e) => (
          <div
            key={e.id}
            style={{
              padding: 12,
              background: 'var(--bg-secondary)',
              borderRadius: 8,
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'flex-start'
            }}
          >
            <div>
              <span style={{ fontSize: 11, color: 'var(--color-primary)' }}>{e.tier}</span>
              <p style={{ fontSize: 13, margin: '4px 0 0' }}>{e.content}</p>
            </div>
            <button
              onClick={() => handleDelete(e.id)}
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
