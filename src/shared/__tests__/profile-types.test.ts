import { describe, it, expect } from 'vitest'
import type {
  ProfileConfig,
  ProfileListResponse,
  ProfileAddRequest,
  ProfileUpdateRequest,
  ProfileExportData,
  ProfileImportData
} from '../profile-types'

describe('Profile Types', () => {
  it('should define ProfileConfig interface', () => {
    const profile: ProfileConfig = {
      id: 'profile-1',
      name: 'Development',
      color: '#007bff',
      isActive: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
    expect(profile).toBeDefined()
    expect(profile.id).toBe('profile-1')
    expect(profile.name).toBe('Development')
    expect(profile.color).toBe('#007bff')
    expect(profile.isActive).toBe(true)
  })

  it('should support optional fields in ProfileConfig', () => {
    const profile: ProfileConfig = {
      id: 'profile-2',
      name: 'Production',
      color: '#28a745',
      isActive: false,
      avatar: 'https://example.com/avatar.png',
      description: 'Production environment profile',
      metadata: { env: 'prod', region: 'us-east-1' },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
    expect(profile.avatar).toBe('https://example.com/avatar.png')
    expect(profile.description).toBe('Production environment profile')
    expect(profile.metadata?.env).toBe('prod')
    expect(profile.metadata?.region).toBe('us-east-1')
  })

  it('should define ProfileListResponse interface', () => {
    const response: ProfileListResponse = {
      profiles: [],
      total: 0,
      activeProfileId: null
    }
    expect(response).toBeDefined()
    expect(response.total).toBe(0)
    expect(response.profiles).toEqual([])
    expect(response.activeProfileId).toBeNull()
  })

  it('should support populated ProfileListResponse', () => {
    const response: ProfileListResponse = {
      profiles: [
        {
          id: 'profile-1',
          name: 'Dev',
          color: '#007bff',
          isActive: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      ],
      total: 1,
      activeProfileId: 'profile-1'
    }
    expect(response.profiles).toHaveLength(1)
    expect(response.total).toBe(1)
    expect(response.activeProfileId).toBe('profile-1')
  })

  it('should define ProfileAddRequest interface', () => {
    const request: ProfileAddRequest = {
      name: 'New Profile'
    }
    expect(request).toBeDefined()
    expect(request.name).toBe('New Profile')
    expect(request.color).toBeUndefined()
    expect(request.avatar).toBeUndefined()
    expect(request.description).toBeUndefined()
    expect(request.metadata).toBeUndefined()
  })

  it('should support all optional fields in ProfileAddRequest', () => {
    const request: ProfileAddRequest = {
      name: 'Full Profile',
      color: '#dc3545',
      avatar: 'https://example.com/img.png',
      description: 'A complete profile',
      metadata: { tags: ['test'] }
    }
    expect(request.color).toBe('#dc3545')
    expect(request.avatar).toBe('https://example.com/img.png')
    expect(request.description).toBe('A complete profile')
    expect(request.metadata?.tags).toEqual(['test'])
  })

  it('should define ProfileUpdateRequest interface', () => {
    const request: ProfileUpdateRequest = {
      id: 'profile-1'
    }
    expect(request).toBeDefined()
    expect(request.id).toBe('profile-1')
    expect(request.name).toBeUndefined()
    expect(request.color).toBeUndefined()
    expect(request.avatar).toBeUndefined()
    expect(request.description).toBeUndefined()
    expect(request.metadata).toBeUndefined()
  })

  it('should support partial updates in ProfileUpdateRequest', () => {
    const request: ProfileUpdateRequest = {
      id: 'profile-1',
      name: 'Updated Name',
      color: '#17a2b8'
    }
    expect(request.id).toBe('profile-1')
    expect(request.name).toBe('Updated Name')
    expect(request.color).toBe('#17a2b8')
  })

  it('should define ProfileExportData interface', () => {
    const exportData: ProfileExportData = {
      profile: {
        id: 'profile-1',
        name: 'Exported Profile',
        color: '#007bff',
        isActive: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      exportedAt: new Date().toISOString(),
      version: '1.0.0'
    }
    expect(exportData).toBeDefined()
    expect(exportData.profile.id).toBe('profile-1')
    expect(exportData.version).toBe('1.0.0')
  })

  it('should define ProfileImportData interface', () => {
    const importData: ProfileImportData = {
      profile: {
        id: 'profile-imported',
        name: 'Imported Profile',
        color: '#ffc107',
        isActive: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    }
    expect(importData).toBeDefined()
    expect(importData.profile.id).toBe('profile-imported')
    expect(importData.profile.name).toBe('Imported Profile')
  })
})
