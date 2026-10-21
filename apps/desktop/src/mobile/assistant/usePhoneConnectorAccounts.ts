import { useCallback, useEffect, useState } from 'react'
import { rendererLogger } from '@/lib/log'
import { TOO_OLD_CODES } from '@/session/renderer/features/remote-hosts/connection-status'
import { machineRpc } from '../agent-watch/sessionpage-rpc'
import { accountLabel } from './phoneConnectorFlow'

const log = rendererLogger('mobile/assistant')

export type ConnectorAccountRow = {
  accountId: string
  /** 一行的标题:账号名 / 邮箱 / @login。 */
  label: string
  /** 一行的副标题:连接于哪天(GitHub 没有连接时间 = null)。 */
  connectedAt: number | null
}

export type PhoneConnectorAccounts = {
  /** null = 还没读到(在读、读失败、这台机器太旧给不出账号清单)。 */
  accounts: ConnectorAccountRow[] | null
  /** false = 那台机器比多账号老(`unknown_method`):详情照旧按单账号画。读失败 / 还在读不算「不支持」。 */
  supported: boolean
  /** 读失败(太旧不算)。 */
  error: unknown
  reload: () => void
}

function isTooOld(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && TOO_OLD_CODES.has(code)
}

/**
 * 一家连着的每个账号:GitHub 问它自己的账号库,邮箱这类多账号的问集成的凭据库(`integrations.accounts`)。
 * `enabled` = 这一家已连接、是多账号 / GitHub、且助理的家醒着:❌ 为数个数逐个登录对方服务,也 ❌ 自己叫醒。
 */
export function usePhoneConnectorAccounts({
  device,
  id,
  name,
  enabled,
  refreshKey,
}: {
  device: string | null
  id: string
  name: string
  enabled: boolean
  /** 连上 / 断开之后换一个值,就重读。 */
  refreshKey: number
}): PhoneConnectorAccounts {
  const [attempt, setAttempt] = useState(0)
  const [read, setRead] = useState<{ key: string; accounts?: ConnectorAccountRow[]; tooOld?: true; error?: unknown } | null>(null)
  const key = `${device}|${id}|${refreshKey}|${attempt}`
  useEffect(() => {
    if (!enabled || !device) return
    let cancelled = false
    const rpc = machineRpc(device)
    void (async () => {
      try {
        const accounts: ConnectorAccountRow[] =
          id === 'github'
            ? (await rpc.github.listAccounts()).map((account) => ({ accountId: account.accountId, label: `@${account.login}`, connectedAt: null }))
            : (await rpc.integrations.accounts(id)).map((account) => ({
                accountId: account.accountId,
                label: accountLabel(account, name),
                connectedAt: account.connectedAt,
              }))
        if (!cancelled) setRead({ key, accounts })
      } catch (error) {
        if (isTooOld(error)) {
          if (!cancelled) setRead({ key, tooOld: true })
          return
        }
        log.warn({ id, error: error instanceof Error ? error.message : String(error) }, 'list connector accounts failed')
        if (!cancelled) setRead({ key, error })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [enabled, device, id, name, key])
  const reload = useCallback(() => setAttempt((n) => n + 1), [])
  const fresh = read?.key === key
  return {
    accounts: fresh ? read?.accounts ?? null : null,
    supported: !(fresh && read?.tooOld),
    error: fresh ? read?.error ?? null : null,
    reload,
  }
}
