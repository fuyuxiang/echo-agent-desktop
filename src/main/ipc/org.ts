import { app, ipcMain, shell } from 'electron'
import log from 'electron-log/main'
import { IpcChannels } from '@shared/ipc-channels'
import type { PromoteRequest } from '@shared/types/org'
import { OrgClient, type Tokens } from '../org/client'
import { OrgCache } from '../org/cache'
import { OrgManager } from '../org/manager'
import { getDb } from '../db'
import { storeGet, storeSet, storeDelete, secureGet, secureSet, secureDelete } from '../store'
import {
  applyOrgPluginConfig,
  setOrgServerUrlProvider,
  setEchoAgentUser
} from '../echo-agent'
import { openOrgDoc } from '../org/open-doc'
import { setEnterpriseModelChat } from '../echo-agent/model-broker'

/**
 * 企业知识库 IPC。
 *
 * 凭证走项目既有的 secureSet(safeStorage 系统级加密),不自己造一套 ——
 * 明文 token 等同于一张长期有效的门禁卡,谁读到配置文件就能冒充这名员工。
 */

const TOKEN_KEY = 'org.tokens'
const ORG_SERVER_KEY = 'org.serverUrl'
const DEVICE_KEY = 'org.deviceId'

let manager: OrgManager | null = null

function readTokens(): Tokens | null {
  const plain = secureGet(TOKEN_KEY)
  if (!plain) return null
  try {
    return JSON.parse(plain) as Tokens
  } catch {
    // 解密失败(换机器、系统密钥环变化)当作未登录,让用户重新登录即可。
    return null
  }
}

function writeTokens(tokens: Tokens): void {
  secureSet(TOKEN_KEY, JSON.stringify(tokens))
}

export function getOrgManager(): OrgManager | null {
  return manager
}

export function registerOrgIpc(getWindow: () => Electron.BrowserWindow | null): void {
  let deviceId = storeGet<string>(DEVICE_KEY)
  if (!deviceId) {
    deviceId = crypto.randomUUID()
    storeSet(DEVICE_KEY, deviceId)
  }

  const getServerUrl = (): string => storeGet<string>(ORG_SERVER_KEY) ?? ''
  setOrgServerUrlProvider(getServerUrl)

  const client = new OrgClient({
    getServerUrl,
    getTokens: async () => readTokens(),
    saveTokens: async (t) => {
      writeTokens(t)
      await manager?.syncPluginCredentials(t)
    },
    clearTokens: async () => {
      secureDelete(TOKEN_KEY)
      setEchoAgentUser(getServerUrl(), null)
      await manager?.clearLocalSession()
    }
  })

  // 缓存表在首次真正用到时才建。registerAllIpcHandlers 可能先于
  // setupDatabase 执行(测试里就是这样),注册阶段调 getDb() 会直接抛错,
  // 把整个 IPC 注册链带崩。
  let cache: OrgCache | null = null
  const getCache = (): OrgCache => {
    cache ??= new OrgCache(getDb())
    return cache
  }

  manager = new OrgManager({
    client,
    get cache() {
      return getCache()
    },
    getServerUrl,
    hasTokens: async () => readTokens() !== null,
    deviceId,
    log: {
      info: (m) => log.info(`[org] ${m}`),
      warn: (m) => log.warn(`[org] ${m}`)
    }
  })
  setEnterpriseModelChat((body, signal) => {
    if (!manager) throw new Error('enterprise client is not initialized')
    return manager.openAiChat(body, signal)
  })

  const notify = async (): Promise<void> => {
    const win = getWindow()
    if (!win || win.isDestroyed()) return
    win.webContents.send(IpcChannels.org.onStatusChanged, await manager!.status())
  }

  ipcMain.handle(IpcChannels.org.status, () => manager!.status())
  ipcMain.handle(IpcChannels.org.modelConfig, () => manager!.modelConfig())

  ipcMain.handle(IpcChannels.org.setServer, async (_e, url: string) => {
    const trimmed = String(url ?? '').trim().replace(/\/$/, '')
    const prev = getServerUrl()
    if (trimmed !== prev) {
      // 换服务器意味着换了一套组织与权限,旧凭证和缓存都不再适用。
      secureDelete(TOKEN_KEY)
      await manager!.clearLocalSession()
      setEchoAgentUser(trimmed, null)
    }
    if (trimmed) storeSet(ORG_SERVER_KEY, trimmed)
    else storeDelete(ORG_SERVER_KEY)
    await applyOrgPluginConfig()
    await notify()
    return manager!.status()
  })

  ipcMain.handle(
    IpcChannels.org.login,
    async (_e, username: string, password: string) => {
      const res = await manager!.login(username, password)
      if (res.ok && res.user) setEchoAgentUser(getServerUrl(), res.user.id)
      await notify()
      return res
    }
  )

  ipcMain.handle(IpcChannels.org.logout, async () => {
    await manager!.logout()
    setEchoAgentUser(getServerUrl(), null)
    await notify()
  })

  ipcMain.handle(IpcChannels.org.sync, async () => {
    const res = await manager!.sync()
    await notify()
    return res
  })

  ipcMain.handle(
    IpcChannels.org.retrieve,
    async (_e, query: string, opts?: { limit?: number; multi_hop?: boolean }) => {
      try {
        return await manager!.retrieve(query, opts ?? {})
      } catch (e) {
        // 凭证失效时返回空结果而非抛错:页面据 status 提示重登,
        // 抛到渲染层只会变成一个没人处理的 rejection。
        log.warn(`[org] 检索失败: ${(e as Error).message}`)
        await notify()
        return {
          chunks: [],
          memories: [],
          diagnostics: {
            bm25Hits: 0,
            vecHits: 0,
            fusedCandidates: 0,
            rerankMs: 0,
            rerankSkipped: true,
            totalMs: 0
          }
        }
      }
    }
  )

  ipcMain.handle(
    IpcChannels.org.listDocs,
    async (_e, params: { scope_id?: string; q?: string; page?: number; size?: number }) => {
      try {
        return await manager!.listDocs(params ?? {})
      } catch (e) {
        log.warn(`[org] 文档列表失败: ${(e as Error).message}`)
        return { items: [], total: 0, page: 1, size: 20 }
      }
    }
  )

  ipcMain.handle(
    IpcChannels.org.listMemories,
    (_e, params?: { q?: string; kind?: string; scope?: string }) =>
      manager!.listMemories(params ?? {})
  )

  ipcMain.handle(IpcChannels.org.scopes, () => manager!.scopes())
  ipcMain.handle(IpcChannels.org.docContent, (_e, id: string, page?: number) =>
    manager!.docContent(id, page)
  )
  ipcMain.handle(IpcChannels.org.docRaw, (_e, id: string) => manager!.docRaw(id))
  ipcMain.handle(IpcChannels.org.openDoc, (_e, id: string) => openOrgDoc(id, {
    docContent: (docId) => manager!.docContent(docId),
    docRaw: (docId) => manager!.docRaw(docId),
    tempRoot: app.getPath('temp'),
    openPath: (file) => shell.openPath(file),
    randomId: () => crypto.randomUUID()
  }))

  ipcMain.handle(IpcChannels.org.promote, (_e, req: PromoteRequest) => manager!.promote(req))

  ipcMain.handle(IpcChannels.org.myPromotions, () => manager!.myPromotions())

  ipcMain.handle(IpcChannels.org.adminListUsers, () => manager!.adminListUsers())
  ipcMain.handle(IpcChannels.org.adminCreateUser, (_e, input) => manager!.adminCreateUser(input))
  ipcMain.handle(IpcChannels.org.adminUpdateUser, (_e, id: string, patch) =>
    manager!.adminUpdateUser(id, patch)
  )
  ipcMain.handle(IpcChannels.org.adminListGroups, () => manager!.adminListGroups())
  ipcMain.handle(IpcChannels.org.adminCreateGroup, (_e, name: string) =>
    manager!.adminCreateGroup(name)
  )

  ipcMain.handle(
    IpcChannels.org.reportQa,
    (_e, body: Parameters<OrgManager['reportQa']>[0]) => manager!.reportQa(body)
  )

  // 启动时恢复会话并补提离线队列。都不阻塞启动。
  void manager
    .restore()
    .then(async (user) => {
      if (user) {
        setEchoAgentUser(getServerUrl(), user.id)
        log.info(`[org] 已恢复企业会话: ${user.displayName}`)
        await manager!.flushPending()
        void manager!.sync()
      }
      await notify()
    })
    .catch(() => {})
}
