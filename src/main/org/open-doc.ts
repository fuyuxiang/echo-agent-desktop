import fs from 'node:fs'
import path from 'node:path'
import type { OrgDocContent } from '@shared/types/org'

const EXTENSIONS: Record<string, ReadonlySet<string>> = {
  pdf: new Set(['.pdf']),
  docx: new Set(['.docx']),
  pptx: new Set(['.pptx']),
  xlsx: new Set(['.xlsx']),
  image: new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']),
  audio: new Set(['.mp3', '.wav', '.m4a', '.flac', '.ogg', '.aac']),
  video: new Set(['.mp4', '.mov', '.webm', '.mkv', '.avi']),
  md: new Set(['.md']),
  txt: new Set(['.txt'])
}

export function safeDocExtension(sourceType: string, title: string): string {
  const candidate = path.extname(title).toLowerCase()
  const allowed = EXTENSIONS[sourceType]
  if (allowed?.has(candidate)) return candidate
  return allowed?.values().next().value ?? '.bin'
}

export interface OpenOrgDocDeps {
  docContent: (id: string) => Promise<OrgDocContent>
  docRaw: (id: string) => Promise<Uint8Array>
  tempRoot: string
  openPath: (file: string) => Promise<string>
  randomId: () => string
  cleanupDelayMs?: number
}

/**
 * 鉴权下载组织文档并交给系统默认应用。调用方只提供服务端文档 ID；文件名、
 * 临时目录和 shell 目标均由主进程生成，避免把通用文件打开能力暴露给渲染层。
 */
export async function openOrgDoc(id: string, deps: OpenOrgDocDeps): Promise<void> {
  if (!id || id.length > 200) throw new Error('文档 ID 无效')
  const [meta, bytes] = await Promise.all([deps.docContent(id), deps.docRaw(id)])
  const dir = path.join(deps.tempRoot, 'echo-agent-docs', String(process.pid))
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = path.join(dir, `${deps.randomId()}${safeDocExtension(meta.sourceType, meta.title)}`)
  fs.writeFileSync(file, bytes, { mode: 0o600 })
  const error = await deps.openPath(file)
  if (error) {
    fs.rmSync(file, { force: true })
    throw new Error(`打开文档失败: ${error}`)
  }
  const cleanup = setTimeout(() => {
    try { fs.rmSync(file, { force: true }) } catch { /* Windows 占用时留给系统临时目录清理 */ }
  }, deps.cleanupDelayMs ?? 60 * 60_000)
  cleanup.unref()
}
