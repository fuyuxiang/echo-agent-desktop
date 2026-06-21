import { registerMock } from './registry'
import { ServerApiUrls } from '@/request/urls'

const now = 1_700_000_000_000

registerMock('GET', ServerApiUrls.projectMemory, () => [
  {
    id: 'm1',
    groupId: 'g1',
    content: '部署用内部 k8s 集群',
    tags: ['部署'],
    sourceUser: 'u1',
    createdAt: now,
    updatedAt: now
  }
])

registerMock('POST', ServerApiUrls.projectMemorySearch, () => [])

registerMock('POST', ServerApiUrls.projectMemory, (p: Record<string, unknown>) => ({
  id: 'm2',
  groupId: 'g1',
  content: p.content,
  tags: (p.tags as string[]) ?? [],
  sourceUser: 'u1',
  createdAt: now,
  updatedAt: now
}))
