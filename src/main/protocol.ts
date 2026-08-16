import { app, BrowserWindow } from 'electron'
import { IpcChannels } from '@shared/ipc-channels'
import { log } from './logger'
import { showMainWindow } from './window'

/** 自定义协议名: echo-agent://xxx 可唤起本应用 */
const PROTOCOL = 'echo-agent'

/**
 * Deep Link 下行 payload: 解析后的路径 + 查询参数。
 * 渲染层拿到后用 react-router 的 navigate(hash 路径)跳转。
 */
export interface DeepLinkPayload {
  /** 形如 '/chat'、'/meeting/abc'(已包含前导 /) */
  path: string
  /** query 字符串(name=value),用于带参跳转(如 /meeting?id=xxx) */
  query: Record<string, string>
}

/**
 * Deep Link 协议注册
 *
 * - mac: 通过 open-url 事件接收
 * - win: 通过 second-instance 的 argv 接收(单实例锁配合)
 * - 解析后的路径通过 broadcastDeepLink() 推给所有窗口;窗口内部跳转
 */
export function setupProtocol(): void {
  if (!app.isDefaultProtocolClient(PROTOCOL)) {
    app.setAsDefaultProtocolClient(PROTOCOL)
  }

  // macOS: 通过协议链接唤起
  app.on('open-url', (event, url) => {
    event.preventDefault()
    handleDeepLink(url)
  })
}

/**
 * 处理 deep link(win 端从 second-instance argv 中提取后也调用此函数)
 * @param url 形如 echo-agent://chat?id=abc
 */
export function handleDeepLink(url: string): void {
  log.info('[protocol] 收到 deep link:', url)
  showMainWindow()
  const payload = parseDeepLink(url)
  if (!payload) {
    log.warn('[protocol] deep link 解析失败或路径不合法:', url)
    return
  }
  // 缓存最新一条,主窗口 ready-to-show 时再补发一次,避免冷启动
  // 协议唤起早于 webContents 装载导致首条 deep link 丢失。
  pendingDeepLink = payload
  broadcastDeepLink(payload)
}

/** 主进程缓存的最新一条 deep link,渲染层 ready-to-show 时取走 */
let pendingDeepLink: DeepLinkPayload | null = null

/**
 * 取走缓存的 deep link(若有),调用方负责把它推到渲染层。
 * 返回后清空,避免重复消费。
 */
export function takePendingDeepLink(): DeepLinkPayload | null {
  const payload = pendingDeepLink
  pendingDeepLink = null
  return payload
}

/** 从命令行参数中提取 deep link(Windows 第二实例启动时) */
export function extractDeepLinkFromArgv(argv: string[]): string | undefined {
  return argv.find((arg) => arg.startsWith(`${PROTOCOL}://`))
}

/**
 * 解析 echo-agent:// URL。
 *
 * - 取第一个路径段 + 其余段拼成 hash 路由路径,例如
 *   echo-agent://chat        -> path='/chat'
 *   echo-agent://meeting/abc -> path='/meeting/abc'
 * - 任何不在 ALLOWED_PATH_PREFIXES 白名单里的路径一律视为非法,
 *   拒绝解析以避免协议被滥用跳到任意位置。
 */
export function parseDeepLink(url: string): DeepLinkPayload | null {
  if (typeof url !== 'string') return null
  // URL 构造器会规范化 ../,先检查原始字符串,避免路径穿越痕迹被抹掉后绕过白名单。
  try {
    const decoded = decodeURIComponent(url)
    if (/(?:^|\/)\.\.?(?:\/|$)/.test(decoded)) return null
  } catch {
    return null
  }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol.replace(':', '') !== PROTOCOL) return null

  // 自定义协议会把第一段放在 host 中:
  // echo-agent://chat -> host=chat、pathname=/
  // echo-agent://meeting/abc -> host=meeting、pathname=/abc
  // 因此这里把 host 与 pathname 合并成应用路由路径。
  const rawPath = `${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`
  const normalized = rawPath ? `/${rawPath.replace(/^\/+/, '')}` : ''
  if (!normalized || normalized === '/') return null
  if (!isAllowedDeepLinkPath(normalized)) return null

  const query: Record<string, string> = {}
  parsed.searchParams.forEach((value, key) => {
    query[key] = value
  })
  return { path: normalized, query }
}

/**
 * 白名单:仅允许 deep link 直接跳到这些路由前缀。
 * 渲染层 hash 路由其它分支由用户主动操作进入,不通过外部协议跳。
 *
 * 使用 { prefix, exact } 而非扁平数组,避免把带子路径的 admin 页面误开。
 * 精确匹配: prefix='/admin' + exact=true 表示只允许 '/admin' 自身,
 * 防止 echo-agent://admin/<任意> 绕过 RequireAdmin 守卫直接跳到子页。
 */
const ALLOWED_PATH_RULES: Array<{ prefix: string; exact?: boolean }> = [
  { prefix: '/chat' },
  { prefix: '/meeting' },
  { prefix: '/knowledge' },
  { prefix: '/skills' },
  { prefix: '/channels' },
  { prefix: '/settings' },
  { prefix: '/example' },
  { prefix: '/memory' },
  { prefix: '/kb-library' },
  { prefix: '/kb-qa' },
  { prefix: '/gateway' },
  { prefix: '/kanban' },
  { prefix: '/soul' },
  { prefix: '/discover' },
  { prefix: '/ask' },
  { prefix: '/org-knowledge' },
  // 管理页:只允许 /admin 自身,子路径需要 RequireAdmin 守卫在前端再校验
  { prefix: '/admin', exact: true },
  { prefix: '/login' }
]

export function isAllowedDeepLinkPath(path: string): boolean {
  if (typeof path !== 'string' || !path.startsWith('/')) return false
  // 防止协议字段里掺进 ../ 或双斜杠绕开校验
  if (path.includes('//') || path.includes('..')) return false
  return ALLOWED_PATH_RULES.some(({ prefix, exact }) => {
    if (path === prefix) return true
    if (exact) return false
    return path.startsWith(`${prefix}/`)
  })
}

/**
 * 把 deep link payload 广播给所有可见窗口。
 * 窗口可能尚未 ready(冷启动 deep link 早于 webContents 装载),
 * 因此在 ready-to-show 之后再发送一次是 OK 的:渲染层订阅是无副作用的。
 */
export function broadcastDeepLink(payload: DeepLinkPayload): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    win.webContents.send(IpcChannels.app.onDeepLink, payload)
  }
}
