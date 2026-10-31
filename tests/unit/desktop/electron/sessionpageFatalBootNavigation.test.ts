/**
 * 会话页「资源没载入」的 fatal(sessionpage/fatal-boot.ts),2026-10-12 macOS 实测的那条链:已登录的页面正在取会话页资源时
 * 被导航一次(⌘R、自动化的 reload),进行中的 fetch 被中止 ⇒ 渲染层报 fatalBoot ⇒ 旧代码弹同步模态错误框、主线程卡死。这里钉两件事:
 * - 报的那份文档正被导航换掉(导航已开始未提交,或发送方的帧已 detached / null):只记一行,❌ 进 fatal;
 * - 资源真坏了:照旧弹同一句话、点了才退出 —— 而且是挂在可见主窗口上的异步框(mac 上没有父窗口的 showMessageBox
 *   也是 runModal,一样堵主线程)。
 * 页面与窗口是假的(EventEmitter / 记录调用),规则只在被测模块里。
 */
import { EventEmitter } from 'node:events'
import { describe, expect, test, vi } from 'vitest'
import {
  FATAL_BOOT_TITLE,
  fatalSessionpageBoot,
  reportFatalBoot,
  watchNavigations,
  type FatalBootDeps,
} from '../../../../apps/desktop/electron/sessionpage/fatal-boot'

type Page = EventEmitter
const page = (): Page => new EventEmitter()
const startNavigation = (p: Page, details: { isMainFrame?: boolean; isSameDocument?: boolean } = {}) =>
  p.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, ...details })
const current = { detached: false }

/** A main window and a dialog that answers when told to (the person clicking OK). */
function rig({ visible = true, destroyed = false, noWindow = false } = {}) {
  let click: () => void = () => {}
  const win = {
    visible,
    isDestroyed: vi.fn(() => destroyed),
    isVisible: vi.fn(() => win.visible),
    show: vi.fn(() => { win.visible = true }),
  }
  const showMessageBox = vi.fn(() => new Promise<{ response: number; checkboxChecked: boolean }>((resolve) => { click = () => resolve({ response: 0, checkboxChecked: false }) }))
  const exit = vi.fn()
  const log = { warn: vi.fn(), error: vi.fn() }
  const deps = { window: () => (noWindow ? null : win), dialog: { showMessageBox }, exit, log } as unknown as FatalBootDeps
  return { win, showMessageBox, exit, log, deps, click: () => click() }
}
const settle = () => new Promise((r) => setTimeout(r, 0))


describe('被导航打断的不是资源坏了', () => {
  test('主框架已经开始导航去另一份文档(还没提交):只记一行,不弹框、不退出', async () => {
    const p = page()
    watchNavigations(p as never)
    startNavigation(p)
    const r = rig()
    expect(reportFatalBoot({ sender: p as never, senderFrame: current }, 'TypeError: Failed to fetch', r.deps)).toBe('navigated')
    await settle()
    expect(r.showMessageBox).not.toHaveBeenCalled()
    expect(r.exit).not.toHaveBeenCalled()
    expect(r.log.warn).toHaveBeenCalledWith({ message: 'TypeError: Failed to fetch' }, expect.stringContaining('interrupted by a navigation'))
    expect(r.log.error).not.toHaveBeenCalled()
  })

  test('发送方的帧已经被换下(detached),或者已经拿不到(null):同样不进 fatal', () => {
    const p = page()
    watchNavigations(p as never)
    const r = rig()
    expect(reportFatalBoot({ sender: p as never, senderFrame: { detached: true } }, 'x', r.deps)).toBe('navigated')
    expect(reportFatalBoot({ sender: p as never, senderFrame: null }, 'x', r.deps)).toBe('navigated')
    expect(r.showMessageBox).not.toHaveBeenCalled()
  })

  test('导航提交了 / 停下了,页面上就是当前文档:它再报就是真坏了', async () => {
    for (const settled of ['did-navigate', 'did-stop-loading']) {
      const p = page()
      watchNavigations(p as never)
      startNavigation(p)
      p.emit(settled)
      const r = rig()
      expect(reportFatalBoot({ sender: p as never, senderFrame: current }, 'TypeError: Failed to fetch', r.deps)).toBe('fatal')
      await settle()
      expect(r.showMessageBox).toHaveBeenCalledTimes(1)
    }
  })

  test('同文档导航(pushState / #)和子框架导航不算「正在离开」', () => {
    for (const details of [{ isSameDocument: true }, { isMainFrame: false }]) {
      const p = page()
      watchNavigations(p as never)
      startNavigation(p, details)
      expect(reportFatalBoot({ sender: p as never, senderFrame: current }, 'x', rig().deps)).toBe('fatal')
    }
  })

  test('没被盯着的页面(不是主窗口):照旧当真失败', () => {
    const p = page()
    startNavigation(p)
    expect(reportFatalBoot({ sender: p as never, senderFrame: current }, 'x', rig().deps)).toBe('fatal')
  })
})

describe('资源真坏了:同一句话,点了才退出,不堵主线程', () => {
  test('FAILED 行先打;错误框挂在主窗口上(异步),人点之前不退出,点了退出 1', async () => {
    const p = page()
    watchNavigations(p as never)
    const r = rig()
    expect(reportFatalBoot({ sender: p as never, senderFrame: current }, 'embedded manifest request failed (404)', r.deps)).toBe('fatal')
    expect(r.log.error).toHaveBeenCalledWith({ message: 'embedded manifest request failed (404)' }, 'FAILED — session page renderer assets unavailable')
    await settle()
    expect(r.showMessageBox).toHaveBeenCalledTimes(1)
    const [parent, options] = r.showMessageBox.mock.calls[0] as unknown as [unknown, { type: string; message: string; detail: string }]
    // A parent window: without one Electron runs the alert modal on mac (message_box_mac.mm) and the main loop stops.
    expect(parent).toBe(r.win)
    expect(options).toMatchObject({ type: 'error', message: FATAL_BOOT_TITLE })
    // The renderer's text as it is: no second `Error:` in front of it, no stack of this process after it.
    expect(options.detail).toBe('embedded manifest request failed (404)')
    expect(r.exit).not.toHaveBeenCalled()
    r.click()
    await settle()
    expect(r.exit).toHaveBeenCalledWith(1)
  })

  test('主窗口还藏着:先显示出来再挂错误框(挂在看不见的窗口上没人点得掉)', async () => {
    const r = rig({ visible: false })
    fatalSessionpageBoot(new Error('boot failed'), r.deps)
    await settle()
    expect(r.win.show).toHaveBeenCalledTimes(1)
    expect(r.win.show.mock.invocationCallOrder[0]).toBeLessThan(r.showMessageBox.mock.invocationCallOrder[0]!)
  })

  test('没有窗口(server、窗口还没建)或窗口已销毁:不弹框,直接退出 1', () => {
    for (const r of [rig({ noWindow: true }), rig({ destroyed: true })]) {
      fatalSessionpageBoot(new Error('boot failed'), r.deps)
      expect(r.showMessageBox).not.toHaveBeenCalled()
      expect(r.exit).toHaveBeenCalledWith(1)
    }
  })

  test('弹不出来(无显示环境):照样退出 1', async () => {
    const r = rig()
    r.showMessageBox.mockImplementationOnce(() => { throw new Error('no display') })
    fatalSessionpageBoot(new Error('boot failed'), r.deps)
    await settle()
    expect(r.exit).toHaveBeenCalledWith(1)
  })
})
