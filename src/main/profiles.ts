import { randomUUID } from 'crypto'
import type {
  ProfileConfig,
  ProfileListResponse,
  ProfileAddRequest,
  ProfileUpdateRequest,
  ProfileExportData,
  ProfileImportData
} from '../shared/profile-types'
import { storeGet, storeSet } from './store'

const PROFILES_KEY = 'profiles.profiles'
const ACTIVE_PROFILE_ID_KEY = 'profiles.activeProfileId'

/** 读取配置列表 */
function getProfiles(): ProfileConfig[] {
  return storeGet<ProfileConfig[]>(PROFILES_KEY) ?? []
}

/** 读取当前激活配置 ID */
function getActiveProfileId(): string | null {
  return storeGet<string | null>(ACTIVE_PROFILE_ID_KEY) ?? null
}

/** 列出所有配置 */
export async function listProfiles(): Promise<ProfileListResponse> {
  const profiles = getProfiles()
  return {
    profiles,
    total: profiles.length,
    activeProfileId: getActiveProfileId()
  }
}

/** 按 ID 获取单个配置 */
export async function getProfile(id: string): Promise<ProfileConfig | null> {
  const profiles = getProfiles()
  return profiles.find(p => p.id === id) || null
}

/** 添加新配置 */
export async function addProfile(request: ProfileAddRequest): Promise<ProfileConfig> {
  const profiles = getProfiles()
  const now = new Date().toISOString()
  const isFirst = profiles.length === 0

  const newProfile: ProfileConfig = {
    id: randomUUID(),
    name: request.name,
    color: request.color ?? '#007bff',
    avatar: request.avatar,
    description: request.description,
    metadata: request.metadata,
    isActive: isFirst,
    createdAt: now,
    updatedAt: now
  }

  profiles.push(newProfile)
  storeSet(PROFILES_KEY, profiles)

  if (isFirst) {
    storeSet(ACTIVE_PROFILE_ID_KEY, newProfile.id)
  }

  return newProfile
}

/** 更新配置 */
export async function updateProfile(request: ProfileUpdateRequest): Promise<ProfileConfig> {
  const profiles = getProfiles()
  const index = profiles.findIndex(p => p.id === request.id)
  if (index === -1) {
    throw new Error(`Profile not found: ${request.id}`)
  }

  const updated: ProfileConfig = {
    ...profiles[index],
    ...request,
    updatedAt: new Date().toISOString()
  }
  profiles[index] = updated
  storeSet(PROFILES_KEY, profiles)
  return updated
}

/** 删除配置 */
export async function deleteProfile(id: string): Promise<void> {
  const profiles = getProfiles()
  const filtered = profiles.filter(p => p.id !== id)
  storeSet(PROFILES_KEY, filtered)

  // 如果删除的是当前激活配置，转移激活状态
  if (getActiveProfileId() === id) {
    storeSet(ACTIVE_PROFILE_ID_KEY, filtered.length > 0 ? filtered[0].id : null)
  }
}

/** 设置激活配置 */
export async function setActiveProfile(id: string): Promise<void> {
  const profiles = getProfiles()
  const updated = profiles.map(p => ({
    ...p,
    isActive: p.id === id
  }))
  storeSet(PROFILES_KEY, updated)
  storeSet(ACTIVE_PROFILE_ID_KEY, id)
}

/** 导出配置 */
export async function exportProfile(id: string): Promise<ProfileExportData> {
  const profile = await getProfile(id)
  if (!profile) {
    throw new Error(`Profile not found: ${id}`)
  }
  return {
    profile,
    exportedAt: new Date().toISOString(),
    version: '1.0.0'
  }
}

/** 导入配置（分配新 ID） */
export async function importProfile(data: ProfileImportData): Promise<ProfileConfig> {
  const profiles = getProfiles()
  const now = new Date().toISOString()

  const newProfile: ProfileConfig = {
    ...data.profile,
    id: randomUUID(),
    isActive: false,
    createdAt: now,
    updatedAt: now
  }

  profiles.push(newProfile)
  storeSet(PROFILES_KEY, profiles)
  return newProfile
}
