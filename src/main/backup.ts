import path from 'node:path'
import fs from 'node:fs'
import { app } from 'electron'
import { nanoid } from 'nanoid'
import { homedir } from 'node:os'
import { log } from './logger'
import { getDb } from './db'
import { echoHome } from './echo-agent/paths'
import type {
  BackupConfig,
  BackupListResponse,
  BackupCreateRequest,
  BackupRestoreRequest
} from '../shared/settings-types'

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** 备份存储根目录: userData/backups */
const getBackupRoot = (): string => path.join(app.getPath('userData'), 'backups')

/** SQLite 数据库文件路径 */
const getDbPath = (): string => path.join(app.getPath('userData'), 'echo.db')

/** electron-store 配置文件路径 (name: 'config') */
const getSettingsPath = (): string => path.join(app.getPath('userData'), 'config.json')

/** 附件目录路径 */
const getAttachmentsDir = (): string => path.join(app.getPath('userData'), 'attachments')

const getAgentWorkspace = (): string => echoHome(homedir())

function resolveBackupDir(id: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('无效的备份 ID')
  return path.join(getBackupRoot(), id)
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/** 递归计算目录大小(字节) */
function getDirSize(dirPath: string): number {
  let size = 0
  const entries = fs.readdirSync(dirPath, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name)
    if (entry.isDirectory()) {
      size += getDirSize(fullPath)
    } else if (entry.isFile()) {
      const stat = fs.statSync(fullPath)
      size += stat.size
    }
  }
  return size
}

// ---------------------------------------------------------------------------
// Backup / Restore core
// ---------------------------------------------------------------------------

export async function listBackups(): Promise<BackupListResponse> {
  const backupRoot = getBackupRoot()
  if (!fs.existsSync(backupRoot)) {
    return { backups: [], total: 0 }
  }

  const dirs = fs.readdirSync(backupRoot, { withFileTypes: true })
  const backups: BackupConfig[] = dirs
    .filter((d) => d.isDirectory())
    .map((d) => {
      const backupDir = path.join(backupRoot, d.name)
      const stat = fs.statSync(backupDir)

      let name = d.name
      let description: string | undefined
      const metaPath = path.join(backupDir, 'meta.json')
      if (fs.existsSync(metaPath)) {
        try {
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
          name = typeof meta.name === 'string' ? meta.name : d.name
          description = typeof meta.description === 'string' ? meta.description : undefined
        } catch {
          log.warn('[backup] 忽略损坏的元数据:', metaPath)
        }
      }

      return {
        id: d.name,
        name,
        size: getDirSize(backupDir),
        description,
        createdAt: stat.birthtime.toISOString()
      }
    })

  return { backups, total: backups.length }
}

export async function createBackup(request: BackupCreateRequest & { metadata?: Record<string, unknown> }): Promise<BackupConfig> {
  const backupRoot = getBackupRoot()
  const backupId = nanoid()
  const backupDir = path.join(backupRoot, backupId)

  // 创建备份目录
  fs.mkdirSync(backupDir, { recursive: true })

  try {
    // better-sqlite3 在线备份会包含 WAL 中已提交的页面，直接复制 echo.db 不会。
    const dbPath = getDbPath()
    if (fs.existsSync(dbPath)) {
      const target = path.join(backupDir, 'echo.db')
      try {
        await getDb().backup(target)
      } catch (e) {
        // 单元测试或极早期启动尚未 setupDatabase 时才允许文件复制兜底。
        if (!String(e).includes('数据库尚未初始化')) throw e
        fs.copyFileSync(dbPath, target)
      }
      log.info('[backup] 数据库已备份')
    }

    // 复制配置文件
    const settingsPath = getSettingsPath()
    if (fs.existsSync(settingsPath)) {
      fs.copyFileSync(settingsPath, path.join(backupDir, 'config.json'))
      log.info('[backup] 配置文件已备份')
    }

    // 复制附件目录
    const attachmentsDir = getAttachmentsDir()
    if (fs.existsSync(attachmentsDir)) {
      fs.cpSync(attachmentsDir, path.join(backupDir, 'attachments'), { recursive: true })
      log.info('[backup] 附件已备份')
    }

    // Agent 是唯一认知内核，其数据/技能/配置也必须进入备份。运行时和内置
    // Python 可重装，企业 access token 不可进入备份。
    const agentWorkspace = getAgentWorkspace()
    if (fs.existsSync(agentWorkspace)) {
      const excludedRoots = new Set(['runtime', 'python', 'node', '.git', 'logs'])
      fs.cpSync(agentWorkspace, path.join(backupDir, 'agent-workspace'), {
        recursive: true,
        filter: (source) => {
          const rel = path.relative(agentWorkspace, source)
          if (!rel) return true
          const parts = rel.split(path.sep)
          if (excludedRoots.has(parts[0])) return false
          if (rel === path.join('plugins', 'org', 'credentials.json')) return false
          if (['gateway.json', '.workspace.lock'].includes(path.basename(source))) return false
          return true
        }
      })
      log.info('[backup] Agent 工作区已备份')
    }

    // Write meta.json sidecar file to persist name, description and createdAt
    const meta = {
      name: request.name,
      description: request.description,
      createdAt: new Date().toISOString()
    }
    fs.writeFileSync(path.join(backupDir, 'meta.json'), JSON.stringify(meta, null, 2))

    const size = getDirSize(backupDir)

    const config: BackupConfig = {
      id: backupId,
      name: request.name,
      size,
      description: request.description,
      metadata: request.metadata,
      createdAt: new Date().toISOString()
    }

    log.info('[backup] 备份完成:', backupId, `(${size} bytes)`)
    return config
  } catch (err) {
    // 清理失败的备份目录
    try {
      fs.rmSync(backupDir, { recursive: true, force: true })
    } catch {
      // ignore cleanup error
    }
    throw err
  }
}

export async function restoreBackup(request: BackupRestoreRequest): Promise<void> {
  const backupDir = resolveBackupDir(request.id)

  if (!fs.existsSync(backupDir)) {
    throw new Error(`备份不存在: ${request.id}`)
  }

  // 恢复数据库
  const dbBackup = path.join(backupDir, 'echo.db')
  if (fs.existsSync(dbBackup)) {
    for (const suffix of ['', '-wal', '-shm']) {
      fs.rmSync(`${getDbPath()}${suffix}`, { force: true })
    }
    fs.copyFileSync(dbBackup, getDbPath())
    log.info('[backup] 数据库已恢复')
  }

  // 恢复配置文件
  const settingsBackup = path.join(backupDir, 'config.json')
  if (fs.existsSync(settingsBackup)) {
    fs.copyFileSync(settingsBackup, getSettingsPath())
    log.info('[backup] 配置文件已恢复')
  }

  // 恢复附件目录
  const attachmentsBackup = path.join(backupDir, 'attachments')
  if (fs.existsSync(attachmentsBackup)) {
    fs.rmSync(getAttachmentsDir(), { recursive: true, force: true })
    fs.cpSync(attachmentsBackup, getAttachmentsDir(), { recursive: true })
    log.info('[backup] 附件已恢复')
  }

  const agentBackup = path.join(backupDir, 'agent-workspace')
  if (fs.existsSync(agentBackup)) {
    const workspace = getAgentWorkspace()
    const credentialPath = path.join(workspace, 'plugins', 'org', 'credentials.json')
    // 身份凭证不属于可迁移备份。恢复 plugins 目录前暂存当前会话凭证；
    // 同时防止旧格式/被篡改的备份趁恢复写入另一个用户的 token。
    const currentCredentials = fs.existsSync(credentialPath)
      ? fs.readFileSync(credentialPath)
      : null
    fs.mkdirSync(workspace, { recursive: true })
    for (const entry of fs.readdirSync(agentBackup)) {
      const source = path.join(agentBackup, entry)
      const target = path.join(workspace, entry)
      fs.rmSync(target, { recursive: true, force: true })
      fs.cpSync(source, target, { recursive: true })
    }
    fs.rmSync(credentialPath, { force: true })
    if (currentCredentials) {
      fs.mkdirSync(path.dirname(credentialPath), { recursive: true })
      fs.writeFileSync(credentialPath, currentCredentials, { mode: 0o600 })
    }
    log.info('[backup] Agent 工作区已恢复')
  }

  log.info('[backup] 恢复完成:', request.id)
}

export async function deleteBackup(id: string): Promise<void> {
  const backupDir = resolveBackupDir(id)

  if (fs.existsSync(backupDir)) {
    fs.rmSync(backupDir, { recursive: true, force: true })
    log.info('[backup] 备份已删除:', id)
  }
  // No throw if not exists - silent no-op
}
