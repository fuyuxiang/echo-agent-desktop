import { storeGet, storeSet } from './store'
import { randomUUID } from 'crypto'
import type {
  BackupConfig,
  BackupListResponse,
  BackupCreateRequest,
  BackupRestoreRequest
} from '../shared/settings-types'

const BACKUPS_KEY = 'settings.backups'

function getBackups(): BackupConfig[] {
  return storeGet<BackupConfig[]>(BACKUPS_KEY) ?? []
}

export async function listBackups(): Promise<BackupListResponse> {
  const backups = getBackups()
  return {
    backups,
    total: backups.length
  }
}

export async function createBackup(request: BackupCreateRequest & { metadata?: Record<string, unknown> }): Promise<BackupConfig> {
  const backups = getBackups()
  const newBackup: BackupConfig = {
    id: randomUUID(),
    name: request.name,
    size: 0,
    description: request.description,
    metadata: request.metadata,
    createdAt: new Date().toISOString()
  }
  backups.push(newBackup)
  storeSet(BACKUPS_KEY, backups)
  return newBackup
}

export async function restoreBackup(request: BackupRestoreRequest): Promise<void> {
  const backups = getBackups()
  const backup = backups.find(b => b.id === request.id)
  if (!backup) {
    throw new Error(`Backup not found: ${request.id}`)
  }
  // In real implementation, this would restore the backup data
  console.log(`Restoring backup: ${backup.name}`)
}

export async function deleteBackup(id: string): Promise<void> {
  const backups = getBackups()
  const filtered = backups.filter(b => b.id !== id)
  storeSet(BACKUPS_KEY, filtered)
}
