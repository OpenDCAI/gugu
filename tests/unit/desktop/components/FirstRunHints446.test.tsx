// @vitest-environment jsdom
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clickElement, createNode, createReactHarness, waitForCondition } from '../../../support/testHarness'
import { stubLayoutIntersection } from '../../../support/layoutIntersection'
import type { FirstRunHintId, FirstRunHintsProgress } from '../../../../apps/desktop/src/lib/firstRunHints'

const io = vi.hoisted(() => ({ read: vi.fn(), dismiss: vi.fn(), warn: vi.fn() }))
vi.mock('../../../../apps/desktop/src/lib/firstRunHints', async (importOriginal) => ({ ...(await importOriginal<object>()), readFirstRunHints: io.read, dismissFirstRunHints: io.dismiss }))
vi.mock('../../../../apps/desktop/src/lib/log', async (importOriginal) => ({ ...(await importOriginal<object>()), rendererLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: io.warn, error: vi.fn() }) }))
const { FirstRunHints } = await import('../../../../apps/desktop/src/components/firstRun/FirstRunHints')
const { AssistantIntro } = await import('../../../../apps/desktop/src/components/assistant/AssistantIntro')
const { i18n } = await import('../../../../apps/desktop/src/i18n/runtime')

type Device = 'phone' | 'desktop'
let account: FirstRunHintsProgress | null
const cleanup: (() => void)[] = []
beforeEach(async () => {
  account = { version: 1, dismissed: [] }
  io.warn.mockReset()
  io.read.mockReset().mockImplementation(async () => account)
  io.dismiss.mockReset().mockImplementation(async (_owner, ids: FirstRunHintId[]) => {
    account = { version: 1, dismissed: [...new Set([...(account?.dismissed ?? []), ...ids])] }
    return account
  })
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })))
  stubLayoutIntersection()
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => new DOMRect(20, 40, 100, 44))
  await i18n.changeLanguage('zh-CN')
})
afterEach(() => {
  cleanup.splice(0).reverse().forEach((fn) => fn())
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function setDevice(device: Device) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: device === 'phone' ? 390 : 1280 })
}
function addEntry(device: Device, id: FirstRunHintId) {
  const region = document.createElement('section')
  if (device === 'phone' && id === 'collaboration') region.className = 'gg-partners'
  if (device === 'desktop' && id === 'assistant') region.className = 'gg-sidebar-rail'
  const entry = document.createElement(id === 'assistant' ? 'button' : 'div')
  entry.dataset.firstRunHint = id
  entry.dataset.firstRunDevice = device
  if (device === 'desktop' && id === 'assistant') entry.dataset.rail = 'assistant'
  if (id === 'collaboration') entry.innerHTML = device === 'phone' ? '<button data-testid="phone-partners-project">Project</button>' : '<button>Projects</button>'
  region.append(entry)
  document.body.append(region)
  const space = document.createElement('div')
  space.dataset.firstRunHintSpace = id
  region.append(space)
  cleanup.push(() => { region.remove(); space.remove() })
  return { region, use: region.querySelector<HTMLElement>('[role="button"], button')! }
}
async function mount(device: Device) {
  setDevice(device)
  const h = createReactHarness()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } })
  await h.render(createNode(QueryClientProvider, { client }, createNode(FirstRunHints, { userId: 'owner-1' })))
  const close = () => { h.cleanup(); client.clear() }
  cleanup.push(close)
  return { ...h, close, client }
}
const bubble = (id: FirstRunHintId) => document.querySelector<HTMLElement>(`[data-testid="first-run-hint-${id}"]`)
async function advance(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
}

describe('device-specific one-page introduction', () => {
  it.each(['phone', 'desktop'] as const)('uses the approved %s entry names and copy', async (device) => {
    setDevice(device)
    const h = createReactHarness()
    cleanup.push(h.cleanup)
    await h.render(createNode(AssistantIntro, { primaryLabel: '开通我的咕咕', onPrimary: vi.fn(), laterLabel: '先逛逛', onLater: vi.fn() }))
    expect([...h.container.querySelectorAll('[data-intro-row]')].map((row) => row.getAttribute('data-intro-row'))).toEqual(device === 'phone' ? ['gugu', 'messages', 'partners'] : ['gugu', 'projects', 'chats'])
    expect(h.container.querySelector('.ta-onb-intro-gugu')?.textContent).toContain(device === 'phone' ? '打开「消息」，第一行就是咕咕。' : '在左栏最上面。')
    expect(h.container.textContent).not.toContain('每件任务')
    expect(h.container.querySelector('.ta-onb-intro')?.children).toHaveLength(2)
  })
})

describe('contextual hints at all four entries', () => {
  for (const device of ['phone', 'desktop'] as const) for (const id of ['assistant', 'collaboration'] as const) {
    it(`${device} ${id}: dismisses once and does not reappear after remount`, async () => {
      setDevice(device)
      addEntry(device, id)
      const first = await mount(device)
      await waitForCondition(() => !!bubble(id), 'entry hint visible')
      if (device !== 'desktop' || id !== 'assistant') expect(bubble(id)?.tagName).toBe('ASIDE')
      await clickElement(bubble(id)!.querySelector('button')!)
      await waitForCondition(() => account?.dismissed.includes(id) === true, 'account saved')
      expect(bubble(id)).toBeNull()
      first.close()
      await mount(device)
      await waitForCondition(() => io.read.mock.calls.length === 2, 'another device read')
      expect(bubble(id)).toBeNull()
    })

    it(`${device} ${id}: using the entry retires its hint`, async () => {
      setDevice(device)
      const entry = addEntry(device, id)
      await mount(device)
      await waitForCondition(() => !!bubble(id), 'entry hint visible')
      await clickElement(entry.use)
      await waitForCondition(() => account?.dismissed.includes(id) === true, 'used entry saved')
      expect(bubble(id)).toBeNull()
    })
  }

  it('shares completion with the corresponding entry on another device', async () => {
    addEntry('phone', 'assistant')
    const first = await mount('phone')
    await waitForCondition(() => !!bubble('assistant'), 'phone hint')
    await clickElement(bubble('assistant')!.querySelector('button')!)
    await waitForCondition(() => account?.dismissed.includes('assistant') === true, 'account saved')
    first.close()
    addEntry('desktop', 'assistant')
    await mount('desktop')
    await waitForCondition(() => io.read.mock.calls.length === 2, 'desktop reads account')
    expect(bubble('assistant')).toBeNull()
  })

  it('shows one hint and does not run through other visible entries after dismissal', async () => {
    addEntry('desktop', 'assistant')
    const project = addEntry('desktop', 'collaboration')
    await mount('desktop')
    await waitForCondition(() => !!bubble('assistant'), 'assistant first')
    expect(bubble('collaboration')).toBeNull()
    await clickElement(bubble('assistant')!.querySelector('button')!)
    await waitForCondition(() => account?.dismissed.includes('assistant') === true, 'account saved')
    expect(bubble('collaboration')).toBeNull()
    await act(async () => { project.region.hidden = true })
    await act(async () => { project.region.hidden = false })
    await waitForCondition(() => !!bubble('collaboration'), 'projects encountered again')
  })

  it('never shows hints for existing accounts', async () => {
    account = null
    addEntry('phone', 'assistant')
    await mount('phone')
    await waitForCondition(() => io.read.mock.calls.length === 1, 'account read')
    expect(bubble('assistant')).toBeNull()
    expect(io.dismiss).not.toHaveBeenCalled()
  })

  it('does not mistake a retained hidden page for a newly encountered entry', async () => {
    const entry = addEntry('phone', 'collaboration')
    entry.region.style.contentVisibility = 'hidden'
    await mount('phone')
    await waitForCondition(() => io.read.mock.calls.length === 1, 'progress read')
    expect(bubble('collaboration')).toBeNull()
    await act(async () => { entry.region.style.contentVisibility = 'visible' })
    await waitForCondition(() => !!bubble('collaboration'), 'page becomes visible')
  })

  it('silently backs off a transient read failure and restores the Chinese hint', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    io.read.mockRejectedValueOnce(new Error('permission denied'))
    addEntry('phone', 'assistant')
    await mount('phone')
    await advance(0)
    expect(io.read).toHaveBeenCalledTimes(1)
    expect(bubble('assistant')).toBeNull()
    expect(document.querySelector('[role="alert"], [data-testid="first-run-hint-error"]')).toBeNull()
    await advance(999)
    expect(io.read).toHaveBeenCalledTimes(1)
    await advance(1)
    expect(io.read).toHaveBeenCalledTimes(2)
    await advance(1) // TanStack publishes the successful retry on the next notification tick.
    expect(bubble('assistant')?.textContent).toContain('咕咕是你的个人助理')
    expect(bubble('assistant')?.textContent).toContain('知道了')
    expect(document.body.textContent).not.toMatch(/permission denied|Retry|Could not read/)
    expect(io.dismiss).not.toHaveBeenCalled()
  })

  it.each(['phone', 'desktop'] as const)('%s: exhausts silent reads without inventing progress, then recovers on a real refetch', async (device) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    io.read.mockRejectedValue(new Error('local request failed: code=1'))
    addEntry(device, 'assistant')
    const h = await mount(device)
    await advance(7000)
    expect(io.read).toHaveBeenCalledTimes(4)
    await advance(60_000)
    expect(io.read).toHaveBeenCalledTimes(4)
    expect(document.querySelector('[data-testid^="first-run-hint-"], [role="alert"], [data-sonner-toast]')).toBeNull()
    expect(document.body.textContent).not.toMatch(/code=1|Retry|提示进度/)
    expect(h.client.getQueryData(['first-run-hints', 'owner-1'])).toBeUndefined()
    expect(io.dismiss).not.toHaveBeenCalled()
    expect(io.warn).toHaveBeenCalledWith({ error: 'Error: local request failed: code=1' }, 'First-run hint progress read failed')
    io.read.mockResolvedValue(account)
    await act(async () => { await h.client.invalidateQueries({ queryKey: ['first-run-hints', 'owner-1'] }) })
    await advance(1)
    expect(bubble('assistant')?.textContent).toContain('知道了')
    expect(h.client.getQueryData(['first-run-hints', 'owner-1'])).toEqual({ version: 1, dismissed: [] })
  })

  it('cancels a pending read retry when its surface unmounts', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    io.read.mockRejectedValue(new Error('offline'))
    addEntry('phone', 'assistant')
    const h = await mount('phone')
    await advance(0)
    expect(io.read).toHaveBeenCalledTimes(1)
    h.close()
    await advance(60_000)
    expect(io.read).toHaveBeenCalledTimes(1)
  })

  it('silently retries a dismissed hint save without asking the user to retry', async () => {
    io.dismiss.mockRejectedValueOnce(new Error('offline'))
    addEntry('phone', 'assistant')
    await mount('phone')
    await waitForCondition(() => !!bubble('assistant'), 'hint visible')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    await clickElement(bubble('assistant')!.querySelector('button')!)
    await advance(0)
    expect(account?.dismissed).toEqual([])
    expect(bubble('assistant')).toBeNull()
    expect(document.querySelector('[role="alert"]')).toBeNull()
    await advance(1000)
    expect(account?.dismissed).toEqual(['assistant'])
    expect(io.dismiss).toHaveBeenCalledTimes(2)
  })

  it('keeps an exhausted save pending and silent without claiming account success', async () => {
    io.dismiss.mockRejectedValue(new Error('permission denied'))
    addEntry('phone', 'assistant')
    const h = await mount('phone')
    await waitForCondition(() => !!bubble('assistant'), 'hint visible')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    await clickElement(bubble('assistant')!.querySelector('button')!)
    await advance(7000)
    expect(io.dismiss).toHaveBeenCalledTimes(4)
    await advance(60_000)
    expect(io.dismiss).toHaveBeenCalledTimes(4)
    expect(account?.dismissed).toEqual([])
    expect(h.client.getQueryData(['first-run-hints', 'owner-1'])).toEqual({ version: 1, dismissed: [] })
    expect(document.querySelector('[data-testid^="first-run-hint-"], [role="alert"], [data-sonner-toast]')).toBeNull()
    expect(io.warn).toHaveBeenCalledWith({ error: 'Error: permission denied' }, 'First-run hint progress save failed')
  })

  it('remembers use while progress is loading and never flashes that hint afterwards', async () => {
    let resolve!: (value: FirstRunHintsProgress) => void
    io.read.mockImplementationOnce(() => new Promise<FirstRunHintsProgress>((done) => { resolve = done }))
    const entry = addEntry('phone', 'assistant')
    await mount('phone')
    await clickElement(entry.use)
    expect(bubble('assistant')).toBeNull()
    await act(async () => resolve({ version: 1, dismissed: [] }))
    await waitForCondition(() => account?.dismissed.includes('assistant') === true, 'early use saved')
    expect(bubble('assistant')).toBeNull()
  })
})
