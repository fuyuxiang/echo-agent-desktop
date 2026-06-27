// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BridgeApi } from '@shared/types/api'
import type { MeetingDTO, SegmentDTO, SummaryDTO } from '@shared/types/meeting'

const router = vi.hoisted(() => ({
  navigate: vi.fn(),
  params: { id: 'm1' }
}))

const userStore = vi.hoisted(() => ({
  signIn: vi.fn(async () => undefined)
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>()
  return {
    ...actual,
    useNavigate: () => router.navigate,
    useParams: () => router.params
  }
})
vi.mock('@/stores/userStore', () => ({
  useUserStore: (selector: (state: { signIn: typeof userStore.signIn }) => unknown) =>
    selector({ signIn: userStore.signIn })
}))
vi.mock('../Settings/sections/GeneralSection', () => ({
  GeneralSection: () => <div>GeneralSection</div>
}))
vi.mock('../Settings/sections/ModelSection', () => ({
  ModelSection: () => <div>ModelSection</div>
}))
vi.mock('../Settings/sections/LocalModelSection', () => ({
  LocalModelSection: () => <div>LocalModelSection</div>
}))
vi.mock('../Settings/sections/AboutSection', () => ({
  AboutSection: () => <div>AboutSection</div>
}))
vi.mock('../Settings/sections/KnowledgeSection', () => ({
  KnowledgeSection: () => <div>KnowledgeSection</div>
}))
vi.mock('@/pages/Memory', () => ({ default: () => <div>MemoryPage</div> }))
vi.mock('@/pages/Skills', () => ({ default: () => <div>SkillsPage</div> }))

const meeting: MeetingDTO = {
  id: 'm1',
  title: '周会',
  startedAt: 1_700_000_000_000,
  endedAt: 1_700_000_060_000,
  durationMs: 60_000,
  audioPath: '/tmp/m1.wav',
  audioSource: 'mic',
  status: 'done',
  createdAt: 1_700_000_000_000
}

const segment: SegmentDTO = {
  id: 1,
  meetingId: 'm1',
  idx: 0,
  startMs: 0,
  endMs: 1000,
  text: '讨论项目进展',
  speaker: 'SPEAKER_00',
  createdAt: 1
}

const summary: SummaryDTO = {
  meetingId: 'm1',
  summary: '会议纪要',
  keyPoints: ['关键点'],
  actionItems: ['待办'],
  model: 'm',
  createdAt: 1
}

function installApi(): BridgeApi {
  const api = {
    meeting: {
      list: vi.fn(async () => ({ meetings: [meeting] })),
      get: vi.fn(async () => ({ meeting, segments: [segment], summary })),
      remove: vi.fn(async () => undefined),
      diarize: vi.fn(async () => ({ segments: [segment] })),
      start: vi.fn(),
      feed: vi.fn(),
      poll: vi.fn(),
      stop: vi.fn(),
      setSummary: vi.fn(),
      rename: vi.fn(),
      markSource: vi.fn()
    }
  } as unknown as BridgeApi
  window.api = api
  return api
}

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  installApi()
  router.params.id = 'm1'
})

afterEach(() => cleanup())

describe('pages', () => {
  it('formatClock 按时长格式化会议计时', async () => {
    const { formatClock } = await import('../Meeting/format')
    expect(formatClock(0)).toBe('00:00')
    expect(formatClock(65_000)).toBe('01:05')
    expect(formatClock(3_665_000)).toBe('1:01:05')
  })

  it('MeetingPage 加载会议列表并点击进入详情', async () => {
    const { default: MeetingPage } = await import('../Meeting')
    render(<MeetingPage />)

    expect(await screen.findByText('周会')).toBeTruthy()
    expect(screen.getByText(/已完成/)).toBeTruthy()
    fireEvent.click(screen.getByText('周会'))
    expect(router.navigate).toHaveBeenCalledWith('/meeting/m1')
  })

  it('MeetingDetail 加载详情、切换全文转写、重试说话人分离并删除会议', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const { default: MeetingDetail } = await import('../Meeting/MeetingDetail')
    render(<MeetingDetail />)

    expect(await screen.findByText('周会')).toBeTruthy()
    expect(screen.getByText('会议纪要')).toBeTruthy()
    expect(screen.getAllByText('关键点').length).toBeGreaterThan(0)
    expect(screen.getAllByText('待办').length).toBeGreaterThan(0)

    fireEvent.click(screen.getByText('全文转写'))
    expect(screen.getByText('讨论项目进展')).toBeTruthy()
    fireEvent.click(screen.getByText('重试说话人分离'))
    await waitFor(() => expect(window.api.meeting.diarize).toHaveBeenCalledWith('m1'))

    fireEvent.click(screen.getByText('删除'))
    await waitFor(() => expect(window.api.meeting.remove).toHaveBeenCalledWith('m1'))
    expect(router.navigate).toHaveBeenCalledWith('/meeting')
    confirm.mockRestore()
  })

  it('Login trim 后提交账号密码并跳转 chat', async () => {
    const { default: Login } = await import('../Login')
    render(<Login />)

    fireEvent.change(screen.getByPlaceholderText('login.username'), {
      target: { value: '  alice  ' }
    })
    fireEvent.change(screen.getByPlaceholderText('login.password'), {
      target: { value: '  secret  ' }
    })
    fireEvent.click(screen.getByText('login.submit'))

    await waitFor(() => expect(userStore.signIn).toHaveBeenCalledWith('alice', 'secret'))
    expect(router.navigate).toHaveBeenCalledWith('/chat', { replace: true })
  })

  it('SettingsPage 根据左侧导航切换分区，KnowledgePage 渲染设置里的知识库区块', async () => {
    const [{ default: SettingsPage }, { default: KnowledgePage }] = await Promise.all([
      import('../Settings'),
      import('../Knowledge')
    ])

    const { rerender } = render(<SettingsPage />)
    expect(screen.getByText('GeneralSection')).toBeTruthy()
    fireEvent.click(screen.getByText('模型配置'))
    expect(screen.getByText('ModelSection')).toBeTruthy()
    fireEvent.click(screen.getByText('本地模型'))
    expect(screen.getByText('LocalModelSection')).toBeTruthy()
    fireEvent.click(screen.getByText('技能库'))
    expect(screen.getByText('SkillsPage')).toBeTruthy()
    fireEvent.click(screen.getByText('记忆'))
    expect(screen.getByText('MemoryPage')).toBeTruthy()
    fireEvent.click(screen.getByText('关于'))
    expect(screen.getByText('AboutSection')).toBeTruthy()

    rerender(<KnowledgePage />)
    expect(screen.getByText('KnowledgeSection')).toBeTruthy()
  })
})
