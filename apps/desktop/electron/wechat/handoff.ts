// 升级交接:桌面第一版在这台电脑上连过的微信,交给管家接着收发(owner 不用重新扫码),交完删掉本机那份。
// 本机已经不再收发(中转搬到了管家),所以交不出去时只记日志、留着文件,下次登录 / 启动再交 ——
// 管家这个环境还没开放(503 not_open)、网络断了都属于这种。
import type { ChatChannelsClient } from '@gugu/core/cloud/chatChannels'
import { isChatChannelsNotOpen } from '@gugu/core/cloud/chatChannels'
import type { LegacyWechatStore } from './store'

export type HandOffOutcome = 'none' | 'handed_off' | 'kept'

export async function handOffLegacyWechat(deps: {
  userId: string
  store: Pick<LegacyWechatStore, 'read' | 'remove'>
  client: ChatChannelsClient | null
  log: { info: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void }
}): Promise<HandOffOutcome> {
  let record
  try {
    record = deps.store.read(deps.userId)
  } catch (error) {
    // 解不开(换了钥匙串、文件坏了):交不出去,也不删 —— 留着给人查;用户在设置里重新扫码即可。
    deps.log.warn({ error: error instanceof Error ? error.message : String(error) }, 'wechat legacy record unreadable, keeping it')
    return 'kept'
  }
  if (!record) return 'none'
  if (!deps.client) {
    deps.log.warn({}, 'wechat legacy record found but this build has no cloud-computer endpoint, keeping it')
    return 'kept'
  }
  try {
    const result = await deps.client.importLegacy('wechat', {
      legacy: { credentials: record.credentials, cursor: record.cursor },
      agentId: record.agentId,
      connectedAt: record.connectedAt,
    })
    deps.store.remove(deps.userId)
    deps.log.info({ result, agentId: record.agentId }, 'wechat legacy connection handed off to the cloud host')
    return 'handed_off'
  } catch (error) {
    deps.log.warn(
      { notOpen: isChatChannelsNotOpen(error), error: error instanceof Error ? error.message : String(error) },
      'wechat legacy hand-off failed, will retry on next sign-in'
    )
    return 'kept'
  }
}
