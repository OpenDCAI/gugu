// @vitest-environment jsdom
import { createElement, isValidElement, useContext, useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sonner = vi.hoisted(() => {
  const base = vi.fn((_title: unknown, _options?: unknown) => 'id')
  return Object.assign(base, {
    success: vi.fn((_title: unknown, _options?: unknown) => 'id'),
    error: vi.fn((_title: unknown, _options?: unknown) => 'id'),
    warning: vi.fn((_title: unknown, _options?: unknown) => 'id'),
    info: vi.fn((_title: unknown, _options?: unknown) => 'id'),
    dismiss: vi.fn(),
  })
})
vi.mock('sonner', () => ({ toast: sonner, Toaster: () => null }))
const noticeLog = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }))
vi.mock('../../../../apps/desktop/src/lib/log', () => ({ rendererLogger: () => noticeLog, hasRendererLogBridge: () => false }))

import { ToastProvider } from '../../../../apps/desktop/src/components/Toast'
import { ToastContext, type ToastType } from '../../../../apps/desktop/src/components/toastContext'
import { dismissNotice, notify } from '../../../../apps/desktop/src/lib/notices'
import { TOAST_DWELL_MS } from '../../../../apps/desktop/src/lib/toastTiers'
import { createReactHarness } from '../../../support/testHarness'

type Options = { id?: string; duration?: number; closeButton?: boolean; className?: string; icon?: unknown; description?: unknown; onDismiss?: () => void; onAutoClose?: () => void }
const lastOptions = (fn: ReturnType<typeof vi.fn>): Options => fn.mock.calls.at(-1)?.[1] as Options

beforeEach(() => {
  // The provider mounts the real NoticeHost, which reads the system theme; jsdom has no media queries.
  vi.stubGlobal('matchMedia', vi.fn((query: string): MediaQueryList => ({
    matches: false, media: query, onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: () => true,
  })))
  for (const fn of [sonner, sonner.success, sonner.error, sonner.warning, sonner.info, sonner.dismiss, noticeLog.warn]) fn.mockClear()
})

afterEach(() => vi.unstubAllGlobals())

describe('提示的档位与停留(全 app 一份,#4891 / #137)', () => {
  it.each<[ToastType, number]>([
    ['success', TOAST_DWELL_MS.success],
    ['info', TOAST_DWELL_MS.info],
    ['warning', TOAST_DWELL_MS.warning],
    ['error', TOAST_DWELL_MS.error],
  ])('%s 按自己的档位停留 %ims', (tier, dwell) => {
    notify({ title: 'boom', tier })
    expect(sonner[tier]).toHaveBeenCalledTimes(1)
    expect(lastOptions(sonner[tier]).duration).toBe(dwell)
  })

  it('warning 是独立一档,不借用 error 的红(#4891)', () => {
    notify({ title: 'residue', tier: 'warning' })
    expect(sonner.warning).toHaveBeenCalledTimes(1)
    expect(sonner.error).not.toHaveBeenCalled()
  })

  it('失败 / 告警带关闭钮 —— 要读要复制的,挡路时能当场关;成功 / 提示没有', () => {
    for (const tier of ['error', 'warning'] as const) {
      notify({ title: tier, tier })
      expect(lastOptions(sonner[tier]).closeButton, tier).toBe(true)
    }
    for (const tier of ['success', 'info'] as const) {
      notify({ title: tier, tier })
      expect(lastOptions(sonner[tier]).closeButton, tier).toBe(false)
    }
  })

  it('转瞬的成功 / 提示点击穿透,别挡住下面的按钮一个停留周期;带动作的、要读的不穿透', () => {
    notify({ title: 'ok', tier: 'success' })
    notify({ title: 'fyi', tier: 'info' })
    expect(lastOptions(sonner.success).className).toBe('gugu-notice-passthrough')
    expect(lastOptions(sonner.info).className).toBe('gugu-notice-passthrough')
    notify({ title: 'undo?', tier: 'success', action: { label: '撤销', onClick: () => {} } })
    notify({ title: 'bad', tier: 'error' })
    expect(lastOptions(sonner.success).className).toBeUndefined()
    expect(lastOptions(sonner.error).className).toBeUndefined()
  })

  it('没给档位的旧调用一字不变:default 走裸 toast,destructive 走 error', () => {
    notify({ title: 'plain' })
    expect(sonner).toHaveBeenCalledWith('plain', expect.not.objectContaining({ duration: expect.anything() }))
    notify({ title: 'failed', variant: 'destructive' })
    expect(sonner.error).toHaveBeenCalledWith('failed', expect.anything())
  })
})

describe('同 key 是同一条:原地更新,不叠', () => {
  it('同 key 活着时是同一个 sonner id(原地更新);不给 key 就是一次性的新提示', () => {
    notify({ key: 'machine:d1', title: '正在重新连接 Mac 1', ongoing: true, waiting: true, tier: 'info' })
    notify({ key: 'machine:d1', title: '连不上 Mac 1', ongoing: true, tier: 'info' })
    const [first, second] = sonner.info.mock.calls.map((call) => (call[1] as Options).id)
    expect(first).toMatch(/^machine:d1#/)
    expect(second).toBe(first)
    notify({ title: 'one-off', tier: 'info' })
    expect(lastOptions(sonner.info).id).toBeUndefined()
  })

  it('一条结束了(被收 / 被关 / 到点),同 key 再发是新的一条:❌ 被排到下一帧的那次收顺手杀掉、❌ 继承上一条的字段', () => {
    notify({ key: 'machine:d2', title: '离线', ongoing: true, tier: 'info' })
    const first = lastOptions(sonner.info).id
    dismissNotice('machine:d2')
    expect(sonner.dismiss).toHaveBeenCalledWith(first)
    notify({ key: 'machine:d2', title: '离线', ongoing: true, tier: 'info' })
    const second = lastOptions(sonner.info).id
    expect(second).not.toBe(first)
    // 用户关掉 / 到点消失同理
    ;(lastOptions(sonner.info) as { onDismiss: () => void }).onDismiss()
    notify({ key: 'machine:d2', title: '离线', ongoing: true, tier: 'info' })
    expect(lastOptions(sonner.info).id).not.toBe(second)
    const third = lastOptions(sonner.info).id
    notify({ key: 'machine:d2', title: '已连接', tier: 'success' })
    ;(lastOptions(sonner.success) as { onAutoClose: () => void }).onAutoClose()
    notify({ key: 'machine:d2', title: '离线', ongoing: true, tier: 'info' })
    expect(lastOptions(sonner.info).id).not.toBe(third)
  })

  it('ongoing 不按停留消失,且一定带关闭钮 —— 常驻的用户想关得关掉', () => {
    for (const tier of ['success', 'info', 'warning', 'error'] as const) {
      notify({ key: tier, title: tier, tier, ongoing: true })
      expect(lastOptions(sonner[tier]), tier).toMatchObject({ duration: Infinity, closeButton: true })
    }
    notify({ key: 'legacy', title: 'x', ongoing: true })
    expect(lastOptions(sonner)).toMatchObject({ duration: Infinity, closeButton: true })
  })

  it('ongoing 的提示不点击穿透:它带着关闭钮,得点得到', () => {
    notify({ key: 'k', title: 'wait', tier: 'info', ongoing: true })
    expect(lastOptions(sonner.info).className).toBeUndefined()
  })

  it('waiting 的图标是产品唯一的加载态组件,❌ 另画 spinner', () => {
    notify({ key: 'k', title: 'wait', tier: 'info', ongoing: true, waiting: true })
    const icon = lastOptions(sonner.info).icon
    expect(isValidElement(icon)).toBe(true)
    notify({ key: 'k', title: 'done', tier: 'success' })
    expect(lastOptions(sonner.success).icon).toBeUndefined()
  })

  it('onDismiss 只在用户亲手关时回调:dismissNotice 收掉的那条,sonner 晚一帧的回调 ❌ 算用户关的', () => {
    const closedByUser = vi.fn()
    notify({ key: 'machine:d4', title: '离线', ongoing: true, tier: 'info', onDismiss: closedByUser })
    const appDismissed = lastOptions(sonner.info) as { onDismiss: () => void }
    dismissNotice('machine:d4')
    // 同 key 紧接着又是新的一条,旧那条的回调这时才到
    notify({ key: 'machine:d4', title: '离线', ongoing: true, tier: 'info', onDismiss: closedByUser })
    appDismissed.onDismiss()
    expect(closedByUser).not.toHaveBeenCalled()
    ;(lastOptions(sonner.info) as { onDismiss: () => void }).onDismiss()
    expect(closedByUser).toHaveBeenCalledTimes(1)
  })

  it('dismissNotice 按 key 收掉活着的那一条;没有这条就什么都不做', () => {
    notify({ key: 'machine:d3', title: '离线', ongoing: true, tier: 'info' })
    const id = lastOptions(sonner.info).id
    dismissNotice('machine:d3')
    expect(sonner.dismiss).toHaveBeenCalledWith(id)
    sonner.dismiss.mockClear()
    dismissNotice('machine:d3')
    dismissNotice('machine:never')
    expect(sonner.dismiss).not.toHaveBeenCalled()
  })
})

describe('主 app 的 toast(message, type) 入口', () => {
  let harness: ReturnType<typeof createReactHarness>
  afterEach(() => harness.cleanup())

  it('不改调用点,落到同一个出口、同一套档位', async () => {
    harness = createReactHarness()
    function Emit({ type }: { type: ToastType }) {
      const { toast } = useContext(ToastContext)
      useEffect(() => { toast('主 app 的提示', type, 'Clipboard write permission denied') }, [toast, type])
      return null
    }
    for (const type of ['success', 'info', 'warning', 'error'] as const) {
      await harness.render(createElement(ToastProvider, null, createElement(Emit, { type })))
      expect(sonner[type], type).toHaveBeenCalledWith('主 app 的提示', expect.objectContaining({ duration: TOAST_DWELL_MS[type], description: 'Clipboard write permission denied' }))
    }
  })
})

describe('用户读到的失败 / 告警落盘', () => {
  it('error、warning、destructive 记下原文,success / info 不记', () => {
    notify({ tier: 'error', key: 'k', title: '发送失败', description: '网络断了' })
    notify({ tier: 'warning', title: '部分没保存' })
    notify({ variant: 'destructive', title: '删不掉' })
    notify({ tier: 'success', title: '已保存' })
    notify({ tier: 'info', title: '提示' })
    expect(noticeLog.warn.mock.calls).toEqual([
      [{ tier: 'error', key: 'k', title: '发送失败', description: '网络断了' }, 'notice shown'],
      [{ tier: 'warning', key: undefined, title: '部分没保存', description: undefined }, 'notice shown'],
      [{ tier: 'error', key: undefined, title: '删不掉', description: undefined }, 'notice shown'],
    ])
  })
})
