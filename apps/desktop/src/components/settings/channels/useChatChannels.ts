import { messageForUser } from '@/lib/userFacingError';
import { rendererLogger } from '@/lib/log';
import { useCallback, useEffect, useMemo, useState } from 'react'
import { isChatChannelsNotOpen, type ChatChannelList, type ChatChannelsClient } from '@gugu/core/cloud/chatChannels'
import { rendererChatChannelsClient } from '../../../lib/chatChannels'

export type ChatChannelsStatus = 'loading' | 'ready' | 'not_open' | 'failed'

/** 健康状况(正常收发 / 重试中 / 暂停)在管家那边变,页面开着时隔一会儿再问一次。 */
const REFRESH_MS = 10_000

/** 设置 → 聊天渠道读到的那份:管家 /channels 的列表。 */
export function useChatChannels(): {
  client: ChatChannelsClient | null
  list: ChatChannelList | null
  status: ChatChannelsStatus
  error: string
  refresh: () => Promise<void>
  apply: (next: ChatChannelList) => void
} {
  const client = useMemo(() => rendererChatChannelsClient(), [])
  const [list, setList] = useState<ChatChannelList | null>(null)
  const [status, setStatus] = useState<ChatChannelsStatus>(client ? 'loading' : 'not_open')

  const [error, setError] = useState('')
  const refresh = useCallback(async () => {
    if (!client) return
    try {
      setList(await client.list())
      setStatus('ready'); setError('')
    } catch (error) {
      if (isChatChannelsNotOpen(error)) setStatus('not_open')
      // 已经显示着一份时,一次刷新失败不把页面换成「加载失败」:下一轮再问。
      else { rendererLogger('settings/channels').error({ error }, 'channel list failed'); setError(messageForUser(error)); setStatus((current) => (current === 'ready' ? current : 'failed')) }
    }
  }, [client])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), REFRESH_MS)
    return () => clearInterval(timer)
  }, [refresh])

  return { client, list, status, error, refresh, apply: setList }
}
