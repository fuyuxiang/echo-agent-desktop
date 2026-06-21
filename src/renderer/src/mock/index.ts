/**
 * Mock 数据注册中心
 *
 * 工作机制:
 * - .env 中 VITE_USE_MOCK=true 时,axios 使用 mock adapter,
 *   按「METHOD 路径」从注册表查找 handler 并返回(自动包成 BaseData 结构)
 * - 后台就绪后改 VITE_USE_MOCK=false 即切真实请求,业务代码零改动
 *
 * 新增 Mock:
 * 1. 新建 mock/xxx.ts,从 './registry' 引入 registerMock 注册
 * 2. 在本文件底部 import 引入(npm run new:page 会自动完成)
 */
export { registerMock, resolveMock, type MockHandler } from './registry'

// ===== 在此引入各模块 Mock(新增文件记得 import) =====
import './example'
import './server'
