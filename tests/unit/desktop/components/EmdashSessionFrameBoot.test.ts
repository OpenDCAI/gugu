// @vitest-environment jsdom
// 会话页起不来只有一个处理(product spec「打开速度」):资源没取到、入口 module 载不进来或求值时出错(import 被拒)、
// renderer bootstrap 被拒(经桥报上来),都是错误卡 + fatalBoot(桌面:主窗口上的错误框 + 退出)。慢不算起不来:等多久都只是加载态 ——
// 入口里等宏任务的顶层 await 让 import 很晚才兑现，也一样。
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../../apps/desktop/src/platform', () => ({ platform: { kind: 'electron' } }))

// The entry's import, one promise per frame: the test settles it as the module graph would.
const entry = vi.hoisted(() => {
  const pending: Array<{ resolve: (value?: unknown) => void; reject: (error: unknown) => void }> = []
  return {
    pending,
    importSessionEntry: vi.fn((_url: string) => new Promise<unknown>((resolve, reject) => { pending.push({ resolve, reject }) })),
  }
})
vi.mock('../../../../apps/desktop/src/components/sessionpage/importSessionEntry', () => ({
  importSessionEntry: entry.importSessionEntry,
}))

import { EmdashSessionFrame } from '../../../../apps/desktop/src/components/sessionpage/EmdashSessionFrame'
import { SESSION_HOST_BRIDGE_KEY } from '../../../../apps/desktop/src/session/renderer/lib/electron-api'
import { SESSION_SHELL_CHANNELS } from '../../../../apps/desktop/src/session/shared/lib/ipc/shell-port'
import { reportSessionRendererBootFailure } from '../../../../apps/desktop/src/session/shared/lib/session-renderer-boot'
import { createReactHarness } from '../../../support/testHarness'

const MODULE_SRC = './assets/session-embedded-boot-test.js'
const sessionMount = () => (window as unknown as { __EMDASH_MOUNT__?: HTMLElement }).__EMDASH_MOUNT__

describe('session page boot', () => {
  let harness: ReturnType<typeof createReactHarness>
  let invoke: ReturnType<typeof vi.fn>

  const loading = () => harness.container.querySelector('[role=status]')
  const errorCard = () => harness.container.querySelector('[role=alert]')

  beforeEach(() => {
    entry.pending.length = 0
    entry.importSessionEntry.mockClear()
    invoke = vi.fn(async () => undefined)
    ;(window as unknown as Record<string, unknown>)[SESSION_HOST_BRIDGE_KEY] = { invoke }
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => `<script type="module" src="${MODULE_SRC}"></script>`,
    })))
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    harness = createReactHarness()
  })

  afterEach(() => {
    harness.cleanup()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    delete (window as unknown as Record<string, unknown>)[SESSION_HOST_BRIDGE_KEY]
  })

  // No deadline: the chain up to the entry's import (mocked fetch → text → parse → import) is all microtasks.
  async function renderUntilEntryImported() {
    await harness.render(createElement(EmdashSessionFrame))
    while (entry.pending.length === 0) await act(async () => { await Promise.resolve() })
    expect(entry.importSessionEntry).toHaveBeenCalledWith(expect.stringContaining('session-embedded-boot-test.js'))
    return entry.pending[0]!
  }

  it('a renderer bootstrap that rejects is fatal: error card and fatalBoot, not an endless loading state', async () => {
    const imported = await renderUntilEntryImported()
    await act(async () => { imported.resolve() })
    expect(loading()).not.toBeNull()

    await act(async () => {
      reportSessionRendererBootFailure(new Error('bootstrap exploded'))
    })

    expect(invoke).toHaveBeenCalledWith(SESSION_SHELL_CHANNELS.fatalBoot, expect.stringContaining('bootstrap exploded'))
    expect(errorCard()).not.toBeNull()
    expect(loading()).toBeNull()
  })

  // Fetching it failed, it did not parse, it threw while evaluating, its top-level await rejected: the import rejects
  // with that error, and the box shows it as it is.
  it('an entry that cannot be loaded or throws while evaluating takes the same path, with its own error', async () => {
    const imported = await renderUntilEntryImported()

    await act(async () => {
      imported.reject(new Error('the entry threw at its top level'))
    })

    expect(invoke).toHaveBeenCalledWith(SESSION_SHELL_CHANNELS.fatalBoot, expect.stringContaining('the entry threw at its top level'))
    expect(errorCard()).not.toBeNull()
    expect(loading()).toBeNull()
  })

  it('an entry that evaluated is not a failure', async () => {
    const imported = await renderUntilEntryImported()

    await act(async () => { imported.resolve() })

    expect(invoke).not.toHaveBeenCalled()
    expect(errorCard()).toBeNull()
    expect(loading()).not.toBeNull()
  })

  // Vite dev (no built CSS): the module's own styles arrive while it evaluates, so the skin bridge must come after them
  // to win the cascade — appended once the import has settled, never before.
  it('the skin bridge follows the module: none before the import settles, one after', async () => {
    const bridges = () => document.head.querySelectorAll('style[data-gugu-skin]').length
    document.head.querySelectorAll('style[data-gugu-skin]').forEach((bridge) => bridge.remove())
    const imported = await renderUntilEntryImported()
    expect(bridges()).toBe(0)

    await act(async () => { imported.resolve() })

    expect(bridges()).toBe(1)
  })

  it('a failed boot keeps its card when the mount fills in afterwards', async () => {
    const imported = await renderUntilEntryImported()
    await act(async () => { imported.resolve() })

    await act(async () => {
      reportSessionRendererBootFailure(new Error('bootstrap exploded after rendering'))
    })
    const mount = sessionMount()
    await act(async () => {
      mount?.appendChild(document.createElement('div'))
    })

    expect(errorCard()).not.toBeNull()
  })

  // A slow machine, or an entry whose top-level await waits on a timer / the network: the import settles late.
  it('slow is not broken: an import that settles ten minutes later is the loading state all along, then the page', async () => {
    vi.useFakeTimers()
    const imported = await renderUntilEntryImported()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * 60_000)
    })
    expect(loading()).not.toBeNull()
    expect(errorCard()).toBeNull()
    expect(invoke).not.toHaveBeenCalled()

    await act(async () => { imported.resolve() })
    const mount = sessionMount()
    await act(async () => {
      mount?.appendChild(document.createElement('div'))
    })
    expect(loading()).toBeNull()
    expect(errorCard()).toBeNull()
    expect(invoke).not.toHaveBeenCalled()
  })
})

// 构建产物：会话页的 CSS 由宿主以 <link rel="stylesheet"> 挂上(@@@entry-css-as-link)—— vite 的预载助手只认 link,
// 注成 <style> 时动态 import 会把入口那张表再插一遍。这里的 EmdashSessionFrame 每格重新 import:资源 promise 是模块级缓存。
describe('session page boot, built stylesheets', () => {
  let harness: ReturnType<typeof createReactHarness>
  let invoke: ReturnType<typeof vi.fn>
  const sheetLinks = () => [...document.head.querySelectorAll<HTMLLinkElement>('link[data-sessionpage-css]')]

  beforeEach(() => {
    entry.pending.length = 0
    entry.importSessionEntry.mockClear()
    invoke = vi.fn(async () => undefined)
    ;(window as unknown as Record<string, unknown>)[SESSION_HOST_BRIDGE_KEY] = { invoke }
    vi.stubEnv('DEV', false)
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        `<link rel="stylesheet" href="./assets/session-a.css"><link rel="stylesheet" href="./assets/vendor-b.css"><script type="module" src="${MODULE_SRC}"></script>`,
    })))
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    document.head.querySelectorAll('link[data-sessionpage-css], style[data-gugu-skin]').forEach((el) => el.remove())
    vi.resetModules()
    harness = createReactHarness()
  })

  afterEach(() => {
    harness.cleanup()
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    delete (window as unknown as Record<string, unknown>)[SESSION_HOST_BRIDGE_KEY]
  })

  async function renderFresh() {
    const { EmdashSessionFrame: Frame } = await import('../../../../apps/desktop/src/components/sessionpage/EmdashSessionFrame')
    await harness.render(createElement(Frame))
    while (sheetLinks().length < 2) await act(async () => { await Promise.resolve() })
  }

  it('attaches every stylesheet as a link in document order, imports the entry only after they load, then the skin bridge', async () => {
    await renderFresh()
    expect(sheetLinks().map((link) => link.getAttribute('href')?.split('/').pop())).toEqual(['session-a.css', 'vendor-b.css'])
    expect(document.head.querySelector('style[data-sessionpage-css]')).toBeNull()
    expect(entry.importSessionEntry).not.toHaveBeenCalled()

    await act(async () => { sheetLinks().forEach((link) => link.dispatchEvent(new Event('load'))) })
    while (entry.pending.length === 0) await act(async () => { await Promise.resolve() })

    const bridge = document.head.querySelector('style[data-gugu-skin]')
    expect(bridge).not.toBeNull()
    expect(sheetLinks().every((link) => link.compareDocumentPosition(bridge!) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true)
  })

  it('a stylesheet that does not load is a failed boot, named in the error', async () => {
    await renderFresh()
    await act(async () => { sheetLinks()[1]!.dispatchEvent(new Event('error')) })
    while (!invoke.mock.calls.length) await act(async () => { await Promise.resolve() })

    expect(invoke).toHaveBeenCalledWith(SESSION_SHELL_CHANNELS.fatalBoot, expect.stringContaining('vendor-b.css'))
    expect(entry.importSessionEntry).not.toHaveBeenCalled()
  })
})
