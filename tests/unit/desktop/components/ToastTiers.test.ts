// @vitest-environment jsdom
import { act, createElement, useContext, useEffect } from 'react'
import { MotionGlobalConfig } from 'framer-motion'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '../../../../apps/desktop/src/components/Toast'
import { ToastContext, type ToastType } from '../../../../apps/desktop/src/components/toastContext'
import { AUTOMATION_TEST_IDS } from '../../../../apps/desktop/src/lib/automationDom'
import { clickElement, createReactHarness } from '../../../support/testHarness'
let harness: ReturnType<typeof createReactHarness>
/** 挂进 provider 里发一条 toast,读到的是真 ToastProvider 渲染出来的 DOM。 */
function Emit({ message, type }: { message: string, type: ToastType }) {
  const { toast } = useContext(ToastContext)
  useEffect(() => { toast(message, type) }, [toast, message, type])
  return null
}
async function emit(type: ToastType, message = 'boom') {
  await harness.render(createElement(ToastProvider, null, createElement(Emit, { message, type })))
}
function card(): HTMLElement | null {
  return harness.container.querySelector(`[data-testid="${AUTOMATION_TEST_IDS.toastItem}"]`)
}
function dismissButton(): HTMLElement | null {
  return harness.container.querySelector(`[data-testid="${AUTOMATION_TEST_IDS.toastDismiss}"]`)
}
beforeEach(() => {
  // AnimatePresence 的退场动画走真实时间,fake timer 推不动它 —— 不关掉的话「已消失」永远读到
  // 那个正在退场的节点。framer 官方开关,比断言组件内部状态干净。
  // This test owns a real ToastProvider; jsdom has no system media queries.
  vi.stubGlobal('matchMedia', vi.fn((query: string): MediaQueryList => ({
    matches: false, media: query, onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: () => true,
  })))
  MotionGlobalConfig.skipAnimations = true
  vi.useFakeTimers()
  harness = createReactHarness()
})
afterEach(() => {
  harness.cleanup()
  vi.useRealTimers()
  MotionGlobalConfig.skipAnimations = false
  vi.unstubAllGlobals()
})
describe('toast 档位与停留', () => {
  it('warning 是独立一档,不再借用 error 的红', async () => {
    await emit('warning')
    // 「做成了但有残留」用 error 红渲染是把结果说重了 —— #4891 审计里 create.toast.cancelWarning 就这么弹的
    expect(card()?.getAttribute('data-toast-type')).toBe('warning')
  })
  it.each<[ToastType, number]>([
    ['success', 3000],
    ['info', 3000],
    ['warning', 5000],
    ['error', 6000],
  ])('%s 停留 %ims:差一毫秒还在,到点才消失', async (type, dwell) => {
    await emit(type)
    expect(card()).not.toBeNull()
    // 两头都断言:只查「到点消失」的话,把时长改成 0 也照样绿
    await act(async () => { vi.advanceTimersByTime(dwell - 1) })
    expect(card(), `${type} 应在 ${dwell - 1}ms 时仍在`).not.toBeNull()
    await act(async () => { vi.advanceTimersByTime(1) })
    expect(card(), `${type} 应在 ${dwell}ms 时已消失`).toBeNull()
  })
  it('失败/告警接指针且文字可选中', async () => {
    for (const type of ['error', 'warning'] as const) {
      await emit(type)
      expect(card()?.style.pointerEvents, type).toBe('auto')
      expect(card()?.style.userSelect, type).toBe('text')
    }
  })
  it('成功/提示仍然点击穿透 —— 别把下面的按钮挡住一个停留周期', async () => {
    for (const type of ['success', 'info'] as const) {
      await emit(type)
      expect(card()?.style.pointerEvents, type).toBe('none')
    }
  })
  it('失败的 toast 挡路时能当场关掉,不用干等 6 秒', async () => {
    await emit('error')
    const dismiss = dismissButton()
    expect(dismiss).not.toBeNull()
    await clickElement(dismiss as HTMLElement)
    expect(card()).toBeNull()
  })
  it('成功的 toast 没有关闭钮 —— 它不占指针,给了也点不到', async () => {
    await emit('success')
    expect(dismissButton()).toBeNull()
  })
})
