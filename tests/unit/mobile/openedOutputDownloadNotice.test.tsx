// @vitest-environment jsdom
import { act, type MouseEvent } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useOpenedOutputOpener } from '../../../apps/desktop/src/mobile/agent-watch/opened-output-opener'
import { ToastContext } from '../../../apps/desktop/src/components/toastContext'
import { clickElement, createNode, createReactHarness } from '../../support/testHarness'

const m = vi.hoisted(() => ({ read: vi.fn(), save: vi.fn(), toast: vi.fn() }))
vi.mock('../../../apps/desktop/src/platform', () => ({ platform: { kind: 'capacitor', saveFile: m.save } }))
vi.mock('../../../apps/desktop/src/hooks/useMobileShell', () => ({ useMobileShell: () => true }))
vi.mock('../../../apps/desktop/src/mobile/agent-watch/sessionpage-rpc', () => ({
  readOpenedFileChunk: m.read,
  SessionpageRpcError: class extends Error { constructor(readonly code: string, message: string) { super(message) } },
}))

let h: ReturnType<typeof createReactHarness>
const chunk = { size: 3, etag: 'immutable-1', data: 'YWJj' }
const temporary = () => Object.assign(new Error('temporary read failure'), { status: 503 })
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }); vi.setSystemTime(0)
  vi.clearAllMocks(); m.read.mockResolvedValue(chunk); m.save.mockResolvedValue({ saved: true })
  h = createReactHarness()
})
afterEach(() => { h.cleanup(); vi.useRealTimers() })

function Fixture() {
  const { handlers, panel } = useOpenedOutputOpener({ deviceId: 'device', sessionId: 'task', onQuote: vi.fn(), readFileChunk: m.read })
  return createNode('div', {}, createNode('button', {
    onClick: (event: MouseEvent<HTMLButtonElement>) => handlers.onOutputMenu?.({ output: { kind: 'file', path: '/workspace/report.txt' }, itemId: 'output', anchor: event.currentTarget }),
  }, 'file menu'), panel)
}
async function render() { await h.render(createNode(ToastContext.Provider, { value: { toast: m.toast } }, createNode(Fixture))) }
async function download() {
  await clickElement(h.container.querySelector('button')!)
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(element => element.textContent === '下载')
  expect(item).toBeDefined()
  await clickElement(item!)
}
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })
const panel = () => document.querySelector('[data-testid="message-file-preview-panel"]')

it('keeps the real phone preview loading through a 60-second outage, then saves exactly once', async () => {
  m.read.mockImplementation(async () => { if (Date.now() < 60_000) throw temporary(); return chunk })
  await render(); await download()
  await advance(59_999)
  expect(panel()?.textContent).toContain('正在从那台电脑取')
  expect(m.toast).not.toHaveBeenCalled(); expect(m.save).not.toHaveBeenCalled()
  await advance(10_001)
  expect(m.save).toHaveBeenCalledExactlyOnceWith(expect.any(Blob), 'report.txt')
  expect(m.toast).not.toHaveBeenCalled()
  expect(panel()?.textContent ?? '').not.toContain('没能从那台电脑取到')
})

it('reports one final notice after 90 seconds without leaving an inline download error', async () => {
  m.read.mockRejectedValue(temporary())
  await render(); await download(); await advance(89_999)
  expect(m.toast).not.toHaveBeenCalled()
  expect(panel()?.textContent).toContain('正在从那台电脑取')
  await advance(1)
  expect(m.toast).toHaveBeenCalledExactlyOnceWith('没能保存这个文件，再试一次。', 'error', '没能从那台电脑取到这个文件，再点一次试试。')
  expect(panel()?.textContent ?? '').not.toContain('没能从那台电脑取到')
  await advance(100_000)
  expect(m.toast).toHaveBeenCalledOnce(); expect(m.save).not.toHaveBeenCalled()
})

it('does not retry 403 and presents its final failure only through the existing notice outlet', async () => {
  m.read.mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }))
  await render(); await download()
  expect(m.read).toHaveBeenCalledOnce(); expect(m.toast).toHaveBeenCalledOnce()
  expect(panel()?.textContent ?? '').not.toContain('没能从那台电脑取到')
  expect(m.save).not.toHaveBeenCalled()
})

it('cancels retries when the pending download is dismissed without a save or failure notice', async () => {
  m.read.mockRejectedValue(temporary())
  await render(); await download()
  const close = document.querySelector<HTMLElement>('[data-testid="message-file-preview-panel"] button[aria-label="关闭"]')
  expect(close).not.toBeNull(); await clickElement(close!)
  await advance(100_000)
  expect(m.read).toHaveBeenCalledOnce(); expect(m.save).not.toHaveBeenCalled(); expect(m.toast).not.toHaveBeenCalled()
})

it('unmounting suppresses late retry and save/error feedback', async () => {
  m.read.mockRejectedValue(temporary())
  await render(); await download(); await h.render(null); await advance(100_000)
  expect(m.read).toHaveBeenCalledOnce(); expect(m.save).not.toHaveBeenCalled(); expect(m.toast).not.toHaveBeenCalled()
})

it('reports a failed system save once without retrying that side effect', async () => {
  m.save.mockRejectedValue(new Error('native save failed'))
  await render(); await download(); await advance(100_000)
  expect(m.read).toHaveBeenCalledOnce(); expect(m.save).toHaveBeenCalledOnce(); expect(m.toast).toHaveBeenCalledOnce()
})

it('ignores a late native read after the download view has unmounted', async () => {
  let resolve!: (value: typeof chunk) => void
  m.read.mockImplementationOnce(() => new Promise<typeof chunk>(done => { resolve = done }))
  await render(); await download(); await h.render(null)
  await act(async () => { resolve(chunk) })
  expect(m.save).not.toHaveBeenCalled(); expect(m.toast).not.toHaveBeenCalled()
})

it('suppresses an obsolete save failure after another file action takes over', async () => {
  let reject!: (error: Error) => void
  m.save.mockImplementationOnce(() => new Promise((_done, failed) => { reject = failed }))
  await render(); await download(); await download()
  expect(m.save).toHaveBeenCalledTimes(2)
  await act(async () => { reject(new Error('old save failed')) })
  expect(m.toast).not.toHaveBeenCalled()
})
