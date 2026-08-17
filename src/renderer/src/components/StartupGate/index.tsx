/**
 * 启动守卫: 登录非强制,未登录也可进入主界面。
 *
 * 启动顺序:
 *   1. 等 echo-agent gateway 就绪(由 AppLayout 处理,这里只是占位);
 *   2. 触发 org store.init(),拉取 status —— 决定是否弹"企业接入"提示;
 *   3. 未接入组织服务时,把 Ask 页设为"待接入"占位,其他功能照常使用。
 */
import { useEffect } from 'react'
import { useOrgStore } from '@/stores/orgStore'

export function StartupGate({ children }: { children: React.ReactNode }): React.JSX.Element {
  const init = useOrgStore((s) => s.init)
  useEffect(() => {
    void init()
  }, [init])
  return <>{children}</>
}
