import { describe, expect, it } from 'vitest'
import { cloudBrowserLine, siteLabel } from '../../../../apps/desktop/src/components/cloudBrowser/cloudBrowserLabels'
import { chunkText, remotePoint } from '../../../../apps/desktop/src/components/cloudBrowser/screenMath'
import type { CloudBrowserState, CloudBrowserStatus } from '../../../../apps/desktop/src/session/shared/cloud-browser'

/** #7199 云浏览器小窗:状态那一行说什么(按优先级)、画面坐标怎么换算、长文字怎么切。 */
const status: CloudBrowserStatus = {
  available: true,
  running: true,
  tabs: [{ tabId: 'T1', title: '京东', url: 'https://www.jd.com/', byAgent: true }],
  activeTabId: 'T1',
  automation: 'running',
  completed: false,
  controlled: false,
  lastActivityAt: new Date().toISOString(),
  assistance: null,
  live: { port: 1, token: 'x' },
}
const state: CloudBrowserState = {
  type: 'state',
  running: true,
  tabs: status.tabs,
  activeTabId: 'T1',
  automation: 'running',
  completed: false,
  control: 'released',
  assistance: null,
}
const base = { live: true, status, state, linkState: 'open' as const, hasFrame: true, releasing: false, everOpened: true }

describe('#7199 cloud browser status line', () => {
  it('agent 在浏览 = 实时 · Agent 正在浏览;还在空白页 = 正在打开网站', () => {
    expect(cloudBrowserLine(base).key).toBe('viewer.watching')
    expect(cloudBrowserLine({ ...base, state: { ...state, tabs: [{ ...state.tabs[0]!, url: 'about:blank' }] } }).key).toBe('viewer.openingSite')
  })

  it('断开 / 连不上给「重新连接」;Chrome 没了 = 会话已结束', () => {
    expect(cloudBrowserLine({ ...base, linkState: 'closed' })).toEqual({ key: 'viewer.disconnected', retry: true })
    expect(cloudBrowserLine({ ...base, linkState: 'failed' })).toEqual({ key: 'viewer.error', retry: true })
    expect(cloudBrowserLine({ ...base, state: { ...state, running: false } }).key).toBe('viewer.ended')
  })

  it('控制权:被别处控制 > 等 Agent 完成当前操作 > 由你接管中;交还中最先说', () => {
    expect(cloudBrowserLine({ ...base, state: { ...state, control: 'occupied' } }).key).toBe('viewer.occupied')
    expect(cloudBrowserLine({ ...base, state: { ...state, control: 'pending' } }).key).toBe('viewer.waiting')
    expect(cloudBrowserLine({ ...base, state: { ...state, control: 'granted' } }).key).toBe('viewer.controlling')
    expect(cloudBrowserLine({ ...base, releasing: true, state: { ...state, control: 'granted' } }).key).toBe('viewer.releasingControl')
  })

  it('停止 / 求助 / 完成', () => {
    expect(cloudBrowserLine({ ...base, state: { ...state, automation: 'stopped' } }).key).toBe('viewer.stopped')
    const assistance = { requestId: 'r', kind: 'login' as const, site: 'https://www.jd.com' }
    expect(cloudBrowserLine({ ...base, state: { ...state, automation: 'idle', assistance } })).toEqual({ key: 'needs', assistance, retry: false })
    // 刚填完密码:实时状态已清掉求助,轮询来的 status 还挂着旧的 → 不再说「需要你完成」
    expect(cloudBrowserLine({ ...base, status: { ...status, assistance }, state: { ...state, automation: 'idle' } }).key).toBe('viewer.idle')
    expect(cloudBrowserLine({ ...base, live: false, linkState: null, state: null, status: { ...status, automation: 'idle', assistance } }).key).toBe('needs')
    expect(cloudBrowserLine({ ...base, state: { ...state, automation: 'idle', completed: true } }).key).toBe('viewer.taskCompleted')
    expect(cloudBrowserLine({ ...base, state: { ...state, automation: 'idle' } }).key).toBe('viewer.idle')
  })

  it('手机(只看小图)不看连接态', () => {
    expect(cloudBrowserLine({ ...base, live: false, state: null, linkState: null }).key).toBe('viewer.watching')
  })

  it('站点名去掉 www.', () => {
    expect(siteLabel('https://www.jd.com')).toBe('jd.com')
  })
})

describe('#7199 cloud browser screen', () => {
  const frame = { width: 640, height: 360, viewportWidth: 1280, viewportHeight: 720 }
  it('contain 缩放居中:本地点换成远端 CSS 坐标;落在黑边上不发', () => {
    // 画面框 400×300,图 640×360 → 缩到 400×225,上下各留 37.5
    const rect = { left: 0, top: 0, width: 400, height: 300 }
    expect(remotePoint({ x: 200, y: 150 }, rect, frame)).toEqual({ x: 640, y: 360 })
    expect(remotePoint({ x: 0, y: 37.5 }, rect, frame)).toEqual({ x: 0, y: 0 })
    expect(remotePoint({ x: 200, y: 10 }, rect, frame)).toBeNull()
  })

  it('长文字按 4096 切,不切开代理对', () => {
    const text = `${'a'.repeat(4095)}😀b`
    const chunks = chunkText(text)
    expect(chunks.join('')).toBe(text)
    expect(chunks[0]).toBe('a'.repeat(4095))
    expect(chunks[1]).toBe('😀b')
  })
})
