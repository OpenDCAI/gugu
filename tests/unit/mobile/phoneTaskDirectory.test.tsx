// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import '../../../apps/desktop/src/i18n/registerAssistantCatalog'
import { PhoneTasks } from '../../../apps/desktop/src/mobile/assistant/PhoneTasks'
import { PhoneRoutineDetail } from '../../../apps/desktop/src/mobile/assistant/PhoneRoutineDetail'
import { usePhoneRoutines } from '../../../apps/desktop/src/mobile/assistant/usePhoneRoutines'
import type { PhonePageProps } from '../../../apps/desktop/src/mobile/assistant/MobileAssistantApp'
import { createReactHarness, renderWithAppProviders } from '../../support/testHarness'
const cloud = vi.hoisted(() => ({ snapshot: vi.fn(),collection: vi.fn(),native: vi.fn(() => { throw new Error('Unexpected device read') }) }))
vi.mock('@/store/devicesContext',() => ({ useDevicesStore: () => ({ devices: [],phones: [] }) }))
vi.mock('@/mobile/agent-watch/sessionpage-rpc',() => ({ machineRpc: cloud.native }))
let harness: ReturnType<typeof createReactHarness>
const page = () => ({ assistant: { id: 'assistant',display_name: '咕咕',avatar: null,created_at: null },chatId: 'dm',ownerName: 'Owner',
  home: { kind: 'cloud',deviceId: 'home' },homeDeviceId: 'home',readiness: 'ready',machine: { state: 'ready',machine: { deviceId: 'home',projectId: 'panel',workspaceId: 'dm',paths: { memoryDir: 'memory' },
    panel: { assistantId: 'assistant',deviceId: 'home',snapshot: cloud.snapshot,collection: cloud.collection } } },askInChat: vi.fn(),sub: null,go: vi.fn(),open: vi.fn() }) as unknown as PhonePageProps
beforeEach(() => { harness = createReactHarness(); cloud.native.mockClear(); cloud.collection.mockReset().mockResolvedValue([]); cloud.snapshot.mockReset().mockResolvedValue({ version: 1,revision: '1',application: [],items: [{ domain: 'tasks',resource_key: '__collection__:home',device_id: 'home',data: { state: 'ready' } }] }) })
afterEach(() => harness.cleanup())
it('reads a successfully empty account task list while its host is offline', async () => {
  await renderWithAppProviders(harness,<PhoneTasks {...page()} />)
  await vi.waitFor(() => expect(harness.container.textContent).toContain('还没有任务'))
  expect(cloud.native).not.toHaveBeenCalled()
})
it('does not turn an unprepared cloud task index into an empty list', async () => {
  cloud.snapshot.mockResolvedValue({ version: 1,revision: '0',application: [],items: [] })
  await renderWithAppProviders(harness,<PhoneTasks {...page()} />)
  await vi.waitFor(() => expect(harness.container.textContent).toContain('还没整理好'))
  expect(harness.container.textContent).not.toContain('还没有任务')
})
it('uses the existing keyboard-enabled task tabs', async () => {
  await renderWithAppProviders(harness,<PhoneTasks {...page()} />)
  const first = harness.container.querySelector<HTMLElement>('[data-testid="assistant-seg-tasks"]')!
  const scheduled = harness.container.querySelector<HTMLElement>('[data-testid="assistant-seg-scheduled"]')!
  await act(async () => { first.focus(); first.dispatchEvent(new KeyboardEvent('keydown',{ key: 'ArrowRight',bubbles: true })) })
  expect(scheduled.getAttribute('aria-selected')).toBe('true'); expect(document.activeElement).toBe(scheduled)
})
it('reads only the account-bound assistant schedules without asking a computer ownership directory', async () => {
  cloud.collection.mockResolvedValue([{ resource_key: 'own-routine',revision: '1',data: { title: 'Own',prompt: 'work',enabled: true },updated_at: '2026-10-26' }])
  let ids: string[] = []
  const input = page()
  function Probe() { ids = usePhoneRoutines(input).routines.map(row => row.id); return null }
  await renderWithAppProviders(harness,<Probe />)
  await vi.waitFor(() => expect(ids).toEqual(['own-routine']))
  expect(cloud.collection).toHaveBeenCalledWith('schedules'); expect(cloud.native).not.toHaveBeenCalled()
})
it.each(['list','detail'])('does not call an unread cloud schedule collection empty or gone in %s', async surface => {
  cloud.collection.mockRejectedValue(new Error('private service diagnostic'))
  await renderWithAppProviders(harness,surface === 'detail' ? <PhoneRoutineDetail {...page()} id="routine" /> : <PhoneTasks {...page()} />)
  if (surface === 'list') await act(async () => { harness.container.querySelector<HTMLElement>('[data-testid="assistant-seg-scheduled"]')!.click() })
  await vi.waitFor(() => expect(harness.container.querySelector('[role="alert"]')).not.toBeNull())
  expect(harness.container.textContent).not.toMatch(/private service diagnostic|暂无定时任务|此定时任务不可用/)
})
it('finishes with the identity failure instead of leaving task reads loading forever', async () => {
  const input = page(); input.machine = { state: 'error',error: { code: 'missing-home' },retry: vi.fn() }
  await renderWithAppProviders(harness,<PhoneTasks {...input} />)
  expect(harness.container.querySelector('[role="alert"]')).not.toBeNull()
  expect(harness.container.querySelector('[data-testid="loading-indicator"]')).toBeNull()
})
