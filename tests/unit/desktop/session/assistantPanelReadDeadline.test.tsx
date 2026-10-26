// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { createReactHarness } from '../../../support/testHarness'
import { MachineGate } from '../../../../apps/desktop/src/session/renderer/features/assistant/assistant-ui'
import { retryAssistantPanelRead } from '@gugu/core/cloud/assistantPanelRead'

vi.mock('react-i18next',async original => ({ ...await original<object>(),useTranslation: () => ({ t: (key: string) => key }) }))
let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { vi.useFakeTimers(); harness = createReactHarness() })
afterEach(() => { harness.cleanup(); vi.useRealTimers() })

it('ends a stuck read after fifteen seconds and keeps the failure visible until recovery', async () => {
  const render = (loading: boolean) => harness.render(createElement(MachineGate,{ loading,error: null,readiness: 'ready',onRetry: vi.fn(),children: 'ready data' }))
  await render(true)
  await act(async () => { await vi.advanceTimersByTimeAsync(15_001) })
  expect(harness.container.querySelector('[role="alert"]')).not.toBeNull()
  expect(harness.container.querySelector('[data-testid="loading-indicator"]')).toBeNull()
  await render(true)
  expect(harness.container.querySelector('[role="alert"]')).not.toBeNull()
  await render(false)
  expect(harness.container.textContent).toBe('ready data')
})

it('does not replace a real query failure with a spinner during automatic retries', async () => {
  let recover = false
  const read = vi.fn(async () => {
    if (!recover) throw new TypeError('network unavailable')
    return 'recovered'
  })
  const client = new QueryClient({ defaultOptions: { queries: { retry: 1,retryDelay: 1000,gcTime: 0 } } })
  function Page() {
    const query = useQuery({ queryKey: ['schedules'],queryFn: read })
    return createElement(MachineGate,{ readiness: 'ready',loading: query.isLoading,error: query.error,onRetry: () => { void query.refetch() },children: query.data })
  }
  await harness.render(createElement(QueryClientProvider,{ client },createElement(Page)))
  await act(async () => { await vi.advanceTimersByTimeAsync(1100) })
  expect(harness.container.querySelector('[role="alert"]')).not.toBeNull()
  await act(async () => { await vi.advanceTimersByTimeAsync(1600) })
  expect(client.getQueryState(['schedules'])).toMatchObject({ status: 'pending',fetchStatus: 'fetching' })
  expect(harness.container.querySelector('[role="alert"]')).not.toBeNull()
  expect(harness.container.querySelector('[data-testid="loading-indicator"]')).toBeNull()
  recover = true
  await act(async () => { await vi.advanceTimersByTimeAsync(1100) })
  expect(harness.container.textContent).toBe('recovered')
  expect(harness.container.querySelector('[role="alert"]')).toBeNull()
  client.clear()
})

it.each(['unprepared','collection-unavailable','application-failed','stale'])('does not retry the fixed snapshot state %s, and reads after publication', async code => {
  let recover = false
  const read = vi.fn(async () => {
    if (!recover) throw Object.assign(new Error('snapshot state'),{ code })
    return 'new publication'
  })
  const client = new QueryClient({ defaultOptions: { queries: { retry: retryAssistantPanelRead,gcTime: 0 } } })
  function Page() {
    const q = useQuery({ queryKey: ['schedules'],queryFn: read })
    return createElement(MachineGate,{ readiness: 'ready',loading: q.isLoading,error: q.error,onRetry: () => { void q.refetch() },children: q.data })
  }
  await harness.render(createElement(QueryClientProvider,{ client },createElement(Page)))
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
  expect(read).toHaveBeenCalledTimes(1)
  expect(harness.container.querySelector('[role="alert"]')).not.toBeNull()
  recover = true
  await act(async () => { await client.invalidateQueries({ queryKey: ['schedules'] }); await vi.advanceTimersByTimeAsync(0) })
  expect(harness.container.textContent).toBe('new publication')
  client.clear()
})
