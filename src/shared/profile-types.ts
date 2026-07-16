export interface ProfileConfig {
  id: string
  name: string
  color: string
  avatar?: string
  isActive: boolean
  description?: string
  metadata?: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface ProfileListResponse {
  profiles: ProfileConfig[]
  total: number
  activeProfileId: string | null
}

export interface ProfileAddRequest {
  name: string
  color?: string
  avatar?: string
  description?: string
  metadata?: Record<string, unknown>
}

export interface ProfileUpdateRequest {
  id: string
  name?: string
  color?: string
  avatar?: string
  description?: string
  metadata?: Record<string, unknown>
}

export interface ProfileExportData {
  profile: ProfileConfig
  exportedAt: string
  version: string
}

export interface ProfileImportData {
  profile: ProfileConfig
}
