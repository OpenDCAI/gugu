import type { CloudBrowserLinkState } from '@/lib/cloudBrowser'
import type { CloudBrowserAssistance, CloudBrowserState, CloudBrowserStatus } from '@/session/shared/cloud-browser'

/**
 * 小窗 / 大窗标题下那一行说什么(按优先级从上往下取第一个命中的)。纯函数。
 * 返回词条 key(cloudBrowser 命名空间)与要不要给「重新连接」。
 */
export type CloudBrowserLine =
  | { key: 'viewer.ended' | 'viewer.disconnected' | 'viewer.error'; retry: boolean }
  | {
      key:
        | 'viewer.connecting'
        | 'viewer.reconnectingBrowser'
        | 'viewer.startingBrowser'
        | 'viewer.releasingControl'
        | 'viewer.occupied'
        | 'viewer.waiting'
        | 'viewer.controlling'
        | 'viewer.stopped'
        | 'viewer.taskCompleted'
        | 'viewer.watching'
        | 'viewer.openingSite'
        | 'viewer.idle'
      retry: false
    }
  | { key: 'needs'; assistance: CloudBrowserAssistance; retry: false }

export type CloudBrowserLineInput = {
  assistance: CloudBrowserAssistance | null
  live: boolean
  status: CloudBrowserStatus | null
  state: CloudBrowserState | null
  linkState: CloudBrowserLinkState | null
  hasFrame: boolean
  releasing: boolean
  everOpened: boolean
}

const BLANK = /^(about:blank|chrome:\/\/newtab\/?)?$/

export function cloudBrowserLine(input: CloudBrowserLineInput): CloudBrowserLine {
  const { live, status, state, linkState } = input
  const running = state?.running ?? status?.running ?? false
  if (!running) return { key: 'viewer.ended', retry: false }
  if (live) {
    if (linkState === 'failed') return { key: 'viewer.error', retry: true }
    if (linkState === 'closed') return { key: 'viewer.disconnected', retry: true }
    if (!state) return { key: input.everOpened ? 'viewer.reconnectingBrowser' : 'viewer.connecting', retry: false }
  }
  if (input.releasing) return { key: 'viewer.releasingControl', retry: false }
  const control = state?.control ?? (status?.controlled ? 'occupied' : 'released')
  if (control === 'occupied') return { key: 'viewer.occupied', retry: false }
  if (control === 'pending') return { key: 'viewer.waiting', retry: false }
  if (control === 'granted') return { key: 'viewer.controlling', retry: false }
  const automation = state?.automation ?? status?.automation ?? 'idle'
  if (automation === 'stopped') return { key: 'viewer.stopped', retry: false }
  // 实时状态在就只认它:求助刚被处理时它已清空,轮询来的 status 还是旧的。
  const assistance = input.assistance
  if (assistance) return { key: 'needs', assistance, retry: false }
  if (state?.completed ?? status?.completed) return { key: 'viewer.taskCompleted', retry: false }
  if (automation === 'running') {
    const tabs = state?.tabs ?? status?.tabs ?? []
    const active = tabs.find((tab) => tab.tabId === (state?.activeTabId ?? status?.activeTabId)) ?? tabs[0]
    return { key: active && !BLANK.test(active.url) ? 'viewer.watching' : 'viewer.openingSite', retry: false }
  }
  if (!input.hasFrame) return { key: 'viewer.startingBrowser', retry: false }
  return { key: 'viewer.idle', retry: false }
}

/** 站点显示名:主机名(去掉 www.)。 */
export function siteLabel(site: string | undefined): string {
  if (!site) return ''
  try {
    return new URL(site).hostname.replace(/^www\./, '')
  } catch {
    return site
  }
}
