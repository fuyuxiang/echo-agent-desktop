// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { AccountMenu } from '../AccountMenu'
import { useUserStore } from '@/stores/userStore'

const navigate = vi.fn()
vi.mock('react-router-dom', () => ({ useNavigate: () => navigate }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }))
;(window as unknown as { api: unknown }).api = {
  store: { set: vi.fn(async () => {}), get: vi.fn(async () => null), delete: vi.fn(async () => {}) }
}

describe('AccountMenu', () => {
  beforeEach(() => {
    navigate.mockClear()
    useUserStore.setState({
      user: { id: 'u1', username: '付玉祥', role: 'admin', groupId: 'g1' },
      isAuthed: true,
      signOut: vi.fn()
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
    useUserStore.setState({ signOut })
    render(<AccountMenu />)
    fireEvent.click(screen.getByText('付玉祥'))
    fireEvent.click(screen.getByText('common.logout'))
    expect(signOut).toHaveBeenCalledTimes(1)
  })

  it('未登录态显示登录按钮', () => {
    useUserStore.setState({ user: null, isAuthed: false })
    render(<AccountMenu />)
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
