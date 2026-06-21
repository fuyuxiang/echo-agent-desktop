import { app } from 'electron'
import { log } from './logger'
import { showMainWindow } from './window'

/** 自定义协议名: echo-agent://xxx 可唤起本应用 */
const PROTOCOL = 'echo-agent'

/**
 * Deep Link 协议注册 — 预留实现
 *
 * - mac: 通过 open-url 事件接收
 * - win: 通过 second-instance 的 argv 接收(单实例锁配合)
 * - 后续业务需要路由跳转时,在 handleDeepLink 中解析 URL 并通过 IPC 通知渲染层
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
 * @param url 形如 echo-agent://page/chat?id=1
 */
export function handleDeepLink(url: string): void {
  log.info('[protocol] 收到 deep link:', url)
  showMainWindow()
  // TODO: 解析 url 并通知渲染层路由跳转
}

/** 从命令行参数中提取 deep link(Windows 第二实例启动时) */
export function extractDeepLinkFromArgv(argv: string[]): string | undefined {
  return argv.find((arg) => arg.startsWith(`${PROTOCOL}://`))
}
