// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { AccountMenu } from '../AccountMenu'
import { useOrgStore } from '@/stores/orgStore'

const navigate = vi.fn()
vi.mock('react-router-dom', () => ({ useNavigate: () => navigate }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }))
;(window as unknown as { api: unknown }).api = {
  store: { set: vi.fn(async () => {}), get: vi.fn(async () => null), delete: vi.fn(async () => {}) }
}

describe('AccountMenu', () => {
  beforeEach(() => {
    navigate.mockClear()
    useOrgStore.setState({
      status: {
        configured: true, serverUrl: 'https://org.example', loggedIn: true,
        user: {
          id: 'u1', username: 'alice', displayName: '付玉祥', role: 'admin',
          clearance: 0, groups: [{ id: 'g1', name: '团队' }], scopes: []
        },
        reachable: true, lastSyncAt: null, cachedDocs: 0, cachedChunks: 0
      },
      logout: vi.fn()
    })
  })
  afterEach(() => cleanup())

  it('登录态渲染首字母与用户名', () => {
    render(<AccountMenu />)
    expect(screen.getByText('付')).toBeTruthy()
    expect(screen.getByText('付玉祥')).toBeTruthy()
  })

  it('点触发区展开菜单,含设置与退出登录', () => {
    render(<AccountMenu />)
    expect(screen.queryByText('common.logout')).toBeNull()
    fireEvent.click(screen.getByText('付玉祥'))
    expect(screen.getByText('common.logout')).toBeTruthy()
    expect(screen.getByText('settings.nav')).toBeTruthy()
  })

  it('点退出登录调用 signOut', () => {
    const signOut = vi.fn()
    useOrgStore.setState({ logout: signOut })
    render(<AccountMenu />)
    fireEvent.click(screen.getByText('付玉祥'))
    fireEvent.click(screen.getByText('common.logout'))
    expect(signOut).toHaveBeenCalledTimes(1)
  })

  it('未登录态展开菜单显示登录按钮', () => {
    useOrgStore.setState({ status: null })
    render(<AccountMenu />)
    expect(screen.getByText('account.guest')).toBeTruthy()
    fireEvent.click(screen.getByText('account.guest'))
    fireEvent.click(screen.getByText('common.login'))
    expect(navigate).toHaveBeenCalledWith('/login')
  })

  it('点设置项导航到 /settings', () => {
    render(<AccountMenu />)
    fireEvent.click(screen.getByText('付玉祥'))
    fireEvent.click(screen.getByText('settings.nav'))
    expect(navigate).toHaveBeenCalledWith('/settings')
  })

  it('在菜单外 mousedown 关闭菜单', () => {
    render(<AccountMenu />)
    fireEvent.click(screen.getByText('付玉祥'))
    expect(screen.getByText('common.logout')).toBeTruthy()
    fireEvent.mouseDown(document.body)
    expect(screen.queryByText('common.logout')).toBeNull()
  })

  it('按 Escape 关闭菜单', () => {
    render(<AccountMenu />)
    fireEvent.click(screen.getByText('付玉祥'))
    expect(screen.getByText('common.logout')).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByText('common.logout')).toBeNull()
  })
})
