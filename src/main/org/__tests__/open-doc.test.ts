import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openOrgDoc, safeDocExtension } from '../open-doc'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function deps(over: Partial<Parameters<typeof openOrgDoc>[1]> = {}) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'org-open-doc-'))
  roots.push(tempRoot)
  return {
    docContent: vi.fn(async () => ({
      docId: 'd1', title: 'report.PDF', sourceType: 'pdf', text: null, chunks: [], rawUrl: '/raw'
    })),
    docRaw: vi.fn(async () => new Uint8Array([1, 2, 3])),
    tempRoot,
    openPath: vi.fn(async () => ''),
    randomId: () => 'safe-id',
    cleanupDelayMs: 60_000,
    ...over
  }
}

describe('openOrgDoc', () => {
  it('只用生成的临时路径打开鉴权下载内容', async () => {
    const d = deps()
    await openOrgDoc('d1', d)
    expect(d.docContent).toHaveBeenCalledWith('d1')
    expect(d.docRaw).toHaveBeenCalledWith('d1')
    const file = vi.mocked(d.openPath).mock.calls[0][0]
    expect(file).toContain(path.join('echo-agent-docs', String(process.pid), 'safe-id.pdf'))
    expect([...fs.readFileSync(file)]).toEqual([1, 2, 3])
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600)
  })

  it('拒绝空或超长 ID', async () => {
    const d = deps()
    await expect(openOrgDoc('', d)).rejects.toThrow(/ID 无效/)
    await expect(openOrgDoc('x'.repeat(201), d)).rejects.toThrow(/ID 无效/)
    expect(d.docRaw).not.toHaveBeenCalled()
  })

  it('系统打开失败时立即删除临时文件', async () => {
    const d = deps({ openPath: vi.fn(async () => 'no application') })
    await expect(openOrgDoc('d1', d)).rejects.toThrow(/no application/)
    const file = vi.mocked(d.openPath).mock.calls[0][0]
    expect(fs.existsSync(file)).toBe(false)
  })
})

describe('safeDocExtension', () => {
  it('保留与服务端类型匹配的真实媒体扩展名', () => {
    expect(safeDocExtension('image', 'photo.JPEG')).toBe('.jpeg')
    expect(safeDocExtension('audio', 'meeting.mp3')).toBe('.mp3')
  })

  it('不信任标题中与类型不匹配的可执行扩展名', () => {
    expect(safeDocExtension('pdf', 'report.exe')).toBe('.pdf')
    expect(safeDocExtension('unknown', 'payload.command')).toBe('.bin')
  })
})
