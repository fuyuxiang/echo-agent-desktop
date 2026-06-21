import { registerMock } from './registry'
import { ServerApiUrls } from '@/request/urls'

registerMock('POST', ServerApiUrls.login, () => ({
  token: 'mock-token',
  user: { id: 'u1', username: 'demo', role: 'admin', groupId: 'g1' }
}))

registerMock('GET', ServerApiUrls.modelConfig, () => ({
  baseUrl: 'https://api.example.com/v1',
  modelName: 'gpt-4o',
  allowLocalOverride: false,
  hasCredential: true
}))
