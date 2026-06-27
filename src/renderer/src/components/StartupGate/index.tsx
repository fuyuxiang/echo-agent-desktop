/**
 * 启动守卫: 登录非强制,未登录也可进入主界面。
 * 保留组件壳以便未来可插入其他启动检查(如版本升级引导)。
 */
export function StartupGate({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <>{children}</>
}
