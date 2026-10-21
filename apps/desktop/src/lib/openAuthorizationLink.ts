import { desktopIpc } from '../platform/desktopIpc'
import { rendererLogger } from './log'
import type { RpcRouter } from '@main/rpc'
import { createRPCClient } from '../session/shared/lib/ipc/rpc'

const log = rendererLogger('integrations/authorization')

/** 授权页开在用户眼前的设备；远端宿主只保存授权，不替用户打开浏览器。 */
export async function openAuthorizationLink(url: string): Promise<void> {
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('Invalid authorization URL')
  const native = desktopIpc()
  log.info({ host: parsed.hostname, client: native ? 'desktop' : 'web' }, 'opening authorization page')
  if (native) {
    // 会话宿主桥可能指向无头/远端进程；打开用户眼前的浏览器只经过本机 preload。
    const local = createRPCClient<Pick<RpcRouter, 'app'>>((channel, ...args) => native.invoke(channel, ...args))
    const result = await local.app.openExternal(parsed.href)
    if (!result.success) throw new Error(result.error)
    log.info({ host: parsed.hostname }, 'system browser accepted authorization page')
  } else {
    window.open(parsed.href, '_blank', 'noopener,noreferrer')
  }
}
