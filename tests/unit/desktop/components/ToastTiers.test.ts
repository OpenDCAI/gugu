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

import { ToastProvider } from '../../../../apps/desktop/src/components/Toast'
import { ToastContext, type ToastType } from '../../../../apps/desktop/src/components/toastContext'
import { dismissNotice, notify } from '../../../../apps/desktop/src/lib/notices'
import { TOAST_DWELL_MS } from '../../../../apps/desktop/src/lib/toastTiers'
import { createReactHarness } from '../../../support/testHarness'

type Options = { id?: string; duration?: number; closeButton?: boolean; className?: string; icon?: unknown; description?: unknown }
const lastOptions = (fn: ReturnType<typeof vi.fn>): Options => fn.mock.calls.at(-1)?.[1] as Options

beforeEach(() => {
  // The provider mounts the real NoticeHost, which reads the system theme; jsdom has no media queries.
  vi.stubGlobal('matchMedia', vi.fn((query: string): MediaQueryList => ({
    matches: false, media: query, onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: () => true,
  })))
  for (const fn of [sonner, sonner.success, sonner.error, sonner.warning, sonner.info, sonner.dismiss]) fn.mockClear()
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
  it('key 作为 id 交给 sonner;不给 key 就是一次性的新提示', () => {
    notify({ key: 'machine:d1', title: '正在重新连接 Mac 1', ongoing: true, waiting: true, tier: 'info' })
    notify({ key: 'machine:d1', title: '连不上 Mac 1', ongoing: true, tier: 'info' })
    expect(sonner.info.mock.calls.map((call) => (call[1] as Options).id)).toEqual(['machine:d1', 'machine:d1'])
    notify({ title: 'one-off', tier: 'info' })
    expect(lastOptions(sonner.info).id).toBeUndefined()
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

  it('dismissNotice 按 key 收掉', () => {
    dismissNotice('machine:d1')
    expect(sonner.dismiss).toHaveBeenCalledWith('machine:d1')
  })
})

describe('主 app 的 toast(message, type) 入口', () => {
  let harness: ReturnType<typeof createReactHarness>
  afterEach(() => harness.cleanup())

  it('不改调用点,落到同一个出口、同一套档位', async () => {
    harness = createReactHarness()
    function Emit({ type }: { type: ToastType }) {
      const { toast } = useContext(ToastContext)
      useEffect(() => { toast('主 app 的提示', type) }, [toast, type])
      return null
    }
    for (const type of ['success', 'info', 'warning', 'error'] as const) {
      await harness.render(createElement(ToastProvider, null, createElement(Emit, { type })))
      expect(sonner[type], type).toHaveBeenCalledWith('主 app 的提示', expect.objectContaining({ duration: TOAST_DWELL_MS[type] }))
    }
  })
})
