import path from 'node:path'
import fs from 'node:fs'
import { app } from 'electron'
import { nanoid } from 'nanoid'
import { log } from './logger'
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
      return {
        id: d.name,
        name: d.name,
        size: getDirSize(backupDir),
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
    // 复制数据库
    const dbPath = getDbPath()
    if (fs.existsSync(dbPath)) {
      fs.copyFileSync(dbPath, path.join(backupDir, 'echo.db'))
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
  const backupRoot = getBackupRoot()
  const backupDir = path.join(backupRoot, request.id)

  if (!fs.existsSync(backupDir)) {
    throw new Error(`备份不存在: ${request.id}`)
  }

  // 恢复数据库
  const dbBackup = path.join(backupDir, 'echo.db')
  if (fs.existsSync(dbBackup)) {
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
    fs.cpSync(attachmentsBackup, getAttachmentsDir(), { recursive: true })
    log.info('[backup] 附件已恢复')
  }

  log.info('[backup] 恢复完成:', request.id)
}

export async function deleteBackup(id: string): Promise<void> {
  const backupRoot = getBackupRoot()
  const backupDir = path.join(backupRoot, id)

  if (!fs.existsSync(backupDir)) {
    throw new Error(`备份不存在: ${id}`)
  }

  fs.rmSync(backupDir, { recursive: true, force: true })
  log.info('[backup] 备份已删除:', id)
}
