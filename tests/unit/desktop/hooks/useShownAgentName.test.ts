// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useShownAgentName } from '../../../../apps/desktop/src/hooks/useShownAgentName'
import { setLocalePreference } from '../../../../apps/desktop/src/i18n'
import { createReactHarness, renderWithAppProviders } from '../../../support/testHarness'
import { ChatClashNames } from '../../../../apps/desktop/src/components/chat/ChatClashNames'

let harness: ReturnType<typeof createReactHarness>
const createdAt = '2026-11-02T08:00:00.000Z'
function Name({ name = 'Codex 5', created = createdAt }: { name?: string; created?: string }) {
  return useShownAgentName({ name, createdAt: created })
}
function Names() {
  return useShownAgentName([
    { name: 'Codex 5', createdAt },
    { name: 'Claude 8', createdAt: '2026-11-02T08:00:10.000Z' },
    { name: 'Research assistant', createdAt },
  ]).join(' / ')
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  vi.setSystemTime(createdAt)
  harness = createReactHarness()
})
afterEach(() => { harness.cleanup(); vi.useRealTimers() })

it.each(['zh-CN', 'en-US'] as const)('localizes the common placeholder and expires without a name event (%s)', async locale => {
  setLocalePreference(locale)
  await renderWithAppProviders(harness, createElement(Name))
  expect(harness.container.textContent).toBe(locale === 'zh-CN' ? '正在起名…' : 'Naming the agent…')
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
  expect(harness.container.textContent).toBe('Codex 5')
})

it('shows a rename immediately and uses the identity clock when mounted after the deadline', async () => {
  await renderWithAppProviders(harness, createElement(Name))
  await renderWithAppProviders(harness, createElement(Name, { name: 'Formal name' }))
  expect(harness.container.textContent).toBe('Formal name')
  vi.setSystemTime(Date.parse(createdAt) + 60_000)
  await renderWithAppProviders(harness, createElement(Name))
  expect(harness.container.textContent).toBe('Codex 5')
})

it('expires grouped labels in creation order while preserving explicit names', async () => {
  await renderWithAppProviders(harness, createElement(Names))
  expect(harness.container.textContent).toBe('正在起名… / 正在起名… / Research assistant')
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
  expect(harness.container.textContent).toBe('Codex 5 / 正在起名… / Research assistant')
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
  expect(harness.container.textContent).toBe('Codex 5 / Claude 8 / Research assistant')
})

it('adds a chat suffix only to an identified member in that chat, leaving task labels plain', async () => {
  function Labels() {
    return useShownAgentName([
      { id: 'a', chatId: 'chat', name: 'Fix login', createdAt: undefined },
      { id: 'a', chatId: 'other', name: 'Fix login', createdAt: undefined },
      { name: 'Fix login', createdAt: undefined },
    ]).join(' / ')
  }
  const names = new Map([['a', 'Fix login #93']])
  await renderWithAppProviders(harness, createElement(ChatClashNames.Provider, { value: { chatId: 'chat', names } }, createElement(Labels)))
  expect(harness.container.textContent).toBe('Fix login #93 / Fix login / Fix login')
  await renderWithAppProviders(harness, createElement(ChatClashNames.Provider, { value: { chatId: 'chat', names: new Map() } }, createElement(Labels)))
  expect(harness.container.textContent).toBe('Fix login / Fix login / Fix login')
})
