// @vitest-environment jsdom
// #7348 新账号的第一次打开(product spec):认识你 → 认识咕咕 → 开通咕咕;老账号 / 走完的直接进主界面;
// 进度读不到如实说 + 重试,❌ 当新账号重走,❌ 当走完放行。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clickElement, createNode, createReactHarness, renderWithAppProviders, typeInto, waitForCondition } from '../../../support/testHarness'

const io = vi.hoisted(() => ({
  firstRunDoneHere: vi.fn((_userId: string) => false),
  rememberFirstRunDone: vi.fn(),
  readFirstRunProgress: vi.fn(),
  writeOccupation: vi.fn(async () => undefined),
  finishFirstRun: vi.fn(async () => '2026-10-16T00:00:00Z'),
  requestAssistantSetupHandoff: vi.fn(),
  startFirstRunHints: vi.fn(async () => undefined),
  enrollSampleProject: vi.fn(async (_userId: string) => undefined),
}))
vi.mock('../../../../apps/desktop/src/lib/firstRun', () => io)
vi.mock('../../../../apps/desktop/src/lib/firstRunHints', () => ({ startFirstRunHints: io.startFirstRunHints, readFirstRunHints: vi.fn(async () => null), dismissFirstRunHints: vi.fn() }))
vi.mock('../../../../apps/desktop/src/lib/sampleProject', () => ({ enrollSampleProject: io.enrollSampleProject }))
const auth = vi.hoisted(() => ({ updateNickname: vi.fn(async () => ({ success: true })), updateAvatar: vi.fn() }))
vi.mock('../../../../apps/desktop/src/lib/auth', () => ({ authService: auth }))
const installer = vi.hoisted(() => ({ mounted: vi.fn() }))
vi.mock('../../../../apps/desktop/src/components/firstRun/FirstRunInstallProvider', () => ({
  FirstRunInstallProvider: ({ children }: { children: import('react').ReactNode }) => {
    installer.mounted()
    return children
  },
}))

const { FirstRunGate } = await import('../../../../apps/desktop/src/components/firstRun/FirstRunGate')

const user = { id: 'u1', email: 'neo@example.com', nickname: 'neo' }
const byTestId = (root: ParentNode, id: string) => root.querySelector<HTMLElement>(`[data-testid="${id}"]`)

async function renderGate(overrides: Partial<typeof user & { identityPending: boolean }> = {}) {
  const harness = createReactHarness()
  const node = createNode(FirstRunGate, { user: { ...user, ...overrides } }, createNode('div', { 'data-testid': 'main-product' }))
  await renderWithAppProviders(harness, node, { auth: { ...user, ...overrides } })
  return harness
}

afterEach(() => {
  vi.clearAllMocks()
  sessionStorage.clear()
})

describe('first run gate (#7348)', () => {
  it('does not mount the desktop harness installer on web or phone', async () => {
    io.readFirstRunProgress.mockResolvedValue({ stage: 'done', occupation: null })
    const harness = await renderGate()
    try {
      await waitForCondition(() => !!byTestId(harness.container, 'main-product'), 'phone-capable product rendered')
      expect(installer.mounted).not.toHaveBeenCalled()
    } finally {
      harness.cleanup()
    }
  })

  it('finished / existing accounts go straight to the product', async () => {
    io.readFirstRunProgress.mockResolvedValue({ stage: 'done', occupation: null })
    const harness = await renderGate()
    try {
      await waitForCondition(() => !!byTestId(harness.container, 'main-product'), 'product rendered')
      expect(byTestId(harness.container, 'first-run-profile')).toBeNull()
    } finally {
      harness.cleanup()
    }
  })

  it('a device that already read "finished" for this account lets it straight in without asking again (offline / slow network)', async () => {
    io.firstRunDoneHere.mockImplementation((userId: string) => userId === 'u1')
    io.readFirstRunProgress.mockRejectedValue(new Error('network down'))
    const harness = await renderGate()
    try {
      expect(byTestId(harness.container, 'main-product')).not.toBeNull()
      expect(byTestId(harness.container, 'full-screen-loader')).toBeNull()
      expect(io.readFirstRunProgress).not.toHaveBeenCalled()
    } finally {
      harness.cleanup()
      io.firstRunDoneHere.mockImplementation(() => false)
      io.readFirstRunProgress.mockReset()
    }
  })

  it('only a read that says "finished" is remembered; "not finished" and "unreadable" are not', async () => {
    io.readFirstRunProgress.mockResolvedValueOnce({ stage: 'done', occupation: null })
    const done = await renderGate()
    try {
      await waitForCondition(() => !!byTestId(done.container, 'main-product'), 'product rendered')
      expect(io.rememberFirstRunDone).toHaveBeenCalledWith('u1')
    } finally {
      done.cleanup()
    }
    vi.clearAllMocks()
    io.readFirstRunProgress.mockResolvedValueOnce({ stage: 'profile', occupation: null })
    const profile = await renderGate()
    try {
      await waitForCondition(() => !!byTestId(profile.container, 'first-run-profile'), 'profile screen')
    } finally {
      profile.cleanup()
    }
    io.readFirstRunProgress.mockRejectedValueOnce(new Error('network down'))
    const unreadable = await renderGate()
    try {
      await waitForCondition(() => !!byTestId(unreadable.container, 'first-run-unreadable'), 'unreadable screen')
    } finally {
      unreadable.cleanup()
    }
    expect(io.rememberFirstRunDone).not.toHaveBeenCalled()
  })

  it('unreadable progress says so and retries; it neither replays the flow nor lets you through', async () => {
    io.readFirstRunProgress.mockRejectedValueOnce(new Error('permission denied for table users'))
    io.readFirstRunProgress.mockResolvedValueOnce({ stage: 'done', occupation: null })
    const harness = await renderGate()
    try {
      await waitForCondition(() => !!byTestId(harness.container, 'first-run-unreadable'), 'unreadable screen')
      expect(harness.container.textContent).toContain('permission denied for table users')
      expect(byTestId(harness.container, 'first-run-retry')).not.toBeNull()
      expect(byTestId(harness.container, 'main-product')).toBeNull()
      expect(byTestId(harness.container, 'first-run-profile')).toBeNull()
      await clickElement(byTestId(harness.container, 'first-run-retry')!)
      await waitForCondition(() => !!byTestId(harness.container, 'main-product'), 'product after retry')
    } finally {
      harness.cleanup()
    }
  })

  it('does not wait for the identity to finish hydrating (a hydration that never lands must not leave the gate spinning)', async () => {
    io.readFirstRunProgress.mockResolvedValue({ stage: 'done', occupation: null })
    const harness = await renderGate({ identityPending: true, nickname: '' })
    try {
      await waitForCondition(() => !!byTestId(harness.container, 'main-product'), 'product rendered while identity is pending')
      expect(io.readFirstRunProgress).toHaveBeenCalledWith('u1')
    } finally {
      harness.cleanup()
    }
  })

  it('profile: a name that arrives after hydration fills the field, but never overwrites what the person typed', async () => {
    io.readFirstRunProgress.mockResolvedValue({ stage: 'profile', occupation: null })
    const harness = createReactHarness()
    const render = (overrides: Partial<typeof user & { identityPending: boolean }>) =>
      renderWithAppProviders(harness, createNode(FirstRunGate, { user: { ...user, ...overrides } }, createNode('div', { 'data-testid': 'main-product' })))
    try {
      await render({ identityPending: true, nickname: '' })
      await waitForCondition(() => !!byTestId(harness.container, 'first-run-profile'), 'profile screen before hydration')
      const name = () => byTestId(harness.container, 'first-run-name') as HTMLInputElement
      expect(name().value).toBe('')
      await render({ nickname: 'neo' })
      expect(name().value).toBe('neo')
      await typeInto(name(), 'Neo')
      await render({ nickname: 'neo-renamed-elsewhere' })
      expect(name().value).toBe('Neo')
    } finally {
      harness.cleanup()
    }
  })

  it('profile: name prefilled, occupation required ("other" needs its sentence), then the intro', async () => {
    io.readFirstRunProgress.mockResolvedValue({ stage: 'profile', occupation: null })
    const harness = await renderGate()
    try {
      await waitForCondition(() => !!byTestId(harness.container, 'first-run-profile'), 'profile screen')
      const name = byTestId(harness.container, 'first-run-name') as HTMLInputElement
      expect(name.value).toBe('neo')
      const next = byTestId(harness.container, 'first-run-profile-continue') as HTMLButtonElement
      expect(next.disabled).toBe(true)
      await clickElement(byTestId(harness.container, 'first-run-occupation-other')!)
      expect(next.disabled).toBe(true)
      await typeInto(byTestId(harness.container, 'first-run-occupation-other-text') as HTMLInputElement, '律师')
      await typeInto(name, 'Neo')
      expect(next.disabled).toBe(false)
      await clickElement(next)
      await waitForCondition(() => !!byTestId(harness.container, 'first-run-intro'), 'intro screen')
      expect(auth.updateNickname).toHaveBeenCalledWith('u1', 'Neo')
      expect(io.writeOccupation).toHaveBeenCalledWith('u1', { key: 'other', text: '律师' })
    } finally {
      harness.cleanup()
    }
  })

  it('intro: "set up my Gugu" finishes the flow and hands off to the assistant setup; "look around" just finishes', async () => {
    io.readFirstRunProgress.mockResolvedValue({ stage: 'intro', occupation: { key: 'research' } })
    const first = await renderGate()
    try {
      await waitForCondition(() => !!byTestId(first.container, 'assistant-intro-primary'), 'intro buttons')
      expect(first.container.querySelectorAll('[data-intro-row]')).toHaveLength(3)
      await clickElement(byTestId(first.container, 'assistant-intro-primary')!)
      await waitForCondition(() => !!byTestId(first.container, 'main-product'), 'product after start')
      expect(io.finishFirstRun).toHaveBeenCalled()
      // #709 走出认识咕咕就给新账号记上示例项目,记在「走完」之前:记不上就不算走完。
      expect(io.enrollSampleProject).toHaveBeenCalledWith('u1')
      expect(io.enrollSampleProject.mock.invocationCallOrder[0]).toBeLessThan(io.finishFirstRun.mock.invocationCallOrder[0]!)
      expect(io.rememberFirstRunDone).toHaveBeenCalledWith('u1')
      expect(io.requestAssistantSetupHandoff).toHaveBeenCalledWith('u1')
    } finally {
      first.cleanup()
    }
    vi.clearAllMocks()
    io.readFirstRunProgress.mockResolvedValue({ stage: 'intro', occupation: { key: 'research' } })
    const second = await renderGate()
    try {
      await waitForCondition(() => !!byTestId(second.container, 'assistant-intro-later'), 'later link')
      await clickElement(byTestId(second.container, 'assistant-intro-later')!)
      await waitForCondition(() => !!byTestId(second.container, 'main-product'), 'product after later')
      expect(io.finishFirstRun).toHaveBeenCalled()
      expect(io.enrollSampleProject).toHaveBeenCalledWith('u1')
      expect(io.requestAssistantSetupHandoff).not.toHaveBeenCalled()
    } finally {
      second.cleanup()
    }
  })

  it('does not finish the intro if enrolling account hint progress fails', async () => {
    io.readFirstRunProgress.mockResolvedValue({ stage: 'intro', occupation: { key: 'design' } })
    io.startFirstRunHints.mockRejectedValueOnce(new Error('hint progress unavailable'))
    const harness = await renderGate()
    try {
      await waitForCondition(() => !!byTestId(harness.container, 'assistant-intro-later'), 'intro')
      await clickElement(byTestId(harness.container, 'assistant-intro-later')!)
      await waitForCondition(() => !!harness.container.querySelector('[role="alert"]'), 'enrollment failure')
      expect(io.finishFirstRun).not.toHaveBeenCalled()
      expect(byTestId(harness.container, 'main-product')).toBeNull()
      await clickElement(byTestId(harness.container, 'assistant-intro-later')!)
      await waitForCondition(() => !!byTestId(harness.container, 'main-product'), 'enrollment retry')
      expect(io.finishFirstRun).toHaveBeenCalledOnce()
    } finally { harness.cleanup() }
  })

  it('does not finish the intro if enrolling the sample project fails (#709)', async () => {
    io.readFirstRunProgress.mockResolvedValue({ stage: 'intro', occupation: { key: 'design' } })
    io.enrollSampleProject.mockRejectedValueOnce(new Error('settings unavailable'))
    const harness = await renderGate()
    try {
      await waitForCondition(() => !!byTestId(harness.container, 'assistant-intro-later'), 'intro')
      await clickElement(byTestId(harness.container, 'assistant-intro-later')!)
      await waitForCondition(() => !!harness.container.querySelector('[role="alert"]'), 'enrollment failure')
      expect(io.finishFirstRun).not.toHaveBeenCalled()
      expect(byTestId(harness.container, 'main-product')).toBeNull()
      await clickElement(byTestId(harness.container, 'assistant-intro-later')!)
      await waitForCondition(() => !!byTestId(harness.container, 'main-product'), 'enrollment retry')
      expect(io.finishFirstRun).toHaveBeenCalledOnce()
    } finally { harness.cleanup() }
  })

  it('a failed finish keeps you on the intro and says it did not save (❌ silently entering the product)', async () => {
    io.readFirstRunProgress.mockResolvedValue({ stage: 'intro', occupation: { key: 'design' } })
    io.finishFirstRun.mockRejectedValueOnce(new Error('network down'))
    const harness = await renderGate()
    try {
      await waitForCondition(() => !!byTestId(harness.container, 'assistant-intro-later'), 'later link')
      await clickElement(byTestId(harness.container, 'assistant-intro-later')!)
      await waitForCondition(() => !!harness.container.querySelector('[role="alert"]'), 'error shown')
      expect(harness.container.textContent).toContain('network down')
      expect(byTestId(harness.container, 'main-product')).toBeNull()
      expect(byTestId(harness.container, 'assistant-intro-later')).not.toBeNull()
      expect(io.rememberFirstRunDone).not.toHaveBeenCalled()
    } finally {
      harness.cleanup()
    }
  })
})
