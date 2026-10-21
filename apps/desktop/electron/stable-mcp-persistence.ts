/**
 * #6264 咕咕 MCP 与集成转发口的「活过宿主进程重启」接线(机制见 session/main/lib/stable-endpoint.ts、gugu-mcp-host.ts)。
 *
 * tmux 里的 agent 拿着重启前的卡来敲门、那条会话还没被重新接上时,把卡上的 key 认回是哪条会话页会话,
 * 交给 `wake` 唤醒它 —— 起会话的路会对同一个 key 再 grant 一次,同一张卡面拿回的正是盘上那张卡。
 * 不属于会话页会话的卡(聊天里的智能体)不唤醒:那些 agent 是宿主的子进程,宿主一退它们就没了,不会有人来敲门。
 */
import { join } from 'node:path'
import type { GuguMcpHostPersistence, PersistedGuguMcpGrant } from './gugu-mcp-host'
import { EndpointPorts, PersistedRecords, type EndpointLog } from './session/main/lib/stable-endpoint'

/** sessionpageSurfaceKey(`taskpage:<会话>`)的反函数;集成那台的 key 是 `taskpage:<会话>:<集成>`,同样认。 */
export function sessionpageSessionOfGrantKey(key: string): string | null {
  return key.match(/^taskpage:([^:]+)(?::|$)/)?.[1] ?? null
}

export function createStableMcpPersistence(input: {
  name: string
  dataDir: string
  /**
   * 会话页后端就绪(开机重注册落定)。端口在开机第一步就绑回来了,卡可能在会话页起好之前就来敲门:
   * 请求先挂在这里(上限是宿主的 restoreTimeoutMs),❌ 回「连接被拒绝」让 agent 的重连次数白白用完。
   */
  ready: () => Promise<unknown>
  /** 宿主在退。等完就绪**再**问:挂着的时候可能已经开始退了,❌ 在关机途中把会话拉起来。 */
  quitting: () => boolean
  wake: (sessionId: string) => Promise<void>
  log: EndpointLog
}): GuguMcpHostPersistence {
  return {
    name: input.name,
    ports: new EndpointPorts(input.dataDir),
    grants: new PersistedRecords<PersistedGuguMcpGrant>(join(input.dataDir, `${input.name}-grants.json`)),
    restore: async (key) => {
      const sessionId = sessionpageSessionOfGrantKey(key)
      if (!sessionId) throw new Error(`grant ${key} does not belong to a session-page session`)
      input.log.info('重启前发出的卡有人来用了:唤醒那条会话', { key, sessionId })
      await input.ready()
      if (input.quitting()) throw new Error('session-page host is shutting down; cannot wake a session')
      await input.wake(sessionId)
    },
    log: input.log,
  }
}

/** 盘上还有几张重启前发出去的卡(有就要在启动时提前绑回端口)。 */
export function persistedMcpGrantCount(dataDir: string, name: string): number {
  return new PersistedRecords<PersistedGuguMcpGrant>(join(dataDir, `${name}-grants.json`)).list().length
}
