// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { AssistantLibraryCard, AssistantLibraryVolume } from '../../../../apps/desktop/src/components/assistant/AssistantLibraryVolume'
import type { AssistantMachine } from '../../../../apps/desktop/src/session/renderer/features/assistant/assistant-machine-core'
import { assistantPaths } from '../../../../apps/desktop/src/session/renderer/features/assistant/assistant-files'
import { clickElement, createReactHarness, renderWithAppProviders, typeInto } from '../../../support/testHarness'
import '../../../../apps/desktop/src/i18n/registerAssistantCatalog'
import { useAssistantPanelPage } from '../../../../apps/desktop/src/lib/assistantPanelPage'

const savedNotice = vi.hoisted(() => vi.fn(async () => null))
vi.mock('@/lib/assistantPanelBridge',() => ({ assistantPanelAccountId: () => null,requireAssistantPanelBridge: () => ({ queueNotice: savedNotice }) }))
let harness: ReturnType<typeof createReactHarness>
const notifications = vi.hoisted(() => new Set<(notice: unknown) => void>())
vi.mock('../../../../apps/desktop/src/mobile/agent-watch/sessionpage-rpc', async importOriginal => ({
  ...await importOriginal<typeof import('../../../../apps/desktop/src/mobile/agent-watch/sessionpage-rpc')>(),
  onMachineEvent: (_device: string, _event: unknown, listener: (notice: unknown) => void) => {
    notifications.add(listener); return () => notifications.delete(listener)
  },
}))
beforeEach(() => { savedNotice.mockClear(); notifications.clear(); harness = createReactHarness() })
afterEach(() => { harness.cleanup(); vi.useRealTimers() })
function fixture() {
  const volume = { kind: 'capabilities', name: 'capabilities', path: '/gugu/library/capabilities', index: '/gugu/library/capabilities' }
  const item = { id: 'calendar', name: '日历', description: '查看安排', group: '工作', path: '/gugu/library/capabilities/calendar', index: '/gugu/library/capabilities/calendar/index.json', modifiedAt: '2026-10-20T00:00:00Z' }
  const read = vi.fn().mockResolvedValue({ volume, content: 'Aggregate index is not the UI', items: [item] })
  const entry = vi.fn().mockResolvedValue({ ...item, content: '# Original instructions' })
  const write = vi.fn().mockResolvedValue({ ...item, content: '' })
  const appCall = vi.fn(async (verb: string, args: { name: string; arguments: Record<string, unknown> }) => {
    if (verb === 'dispatch') return { to: { agent: 'user:assistant' }, id: 'durable-message', deferred: true }
    if (verb === 'callProgram' && args.name === 'library_write') return { content: [], structuredContent: { result: await write(args.arguments) } }
    throw new Error('Unexpected App call')
  })
  const machine = { deviceId: 'owned-device', projectId: 'project', workspaceId: 'workspace', home: '/owner', paths: assistantPaths('/owner', '/owner/assistant', 'computer'), rpc: { app: { getUserLibraryVolume: read, readUserLibraryEntry: entry, writeUserLibraryEntry: write, assistantAppCall: appCall } } } as unknown as AssistantMachine
  return { machine, read, entry, write, appCall }
}

describe('Gugu structured capabilities', () => {
  it('uses the toolbar to return editor → capability → list without a content breadcrumb', async () => {
    const toolbar = createReactHarness()
    function Toolbar() { const page = useAssistantPanelPage(); return page ? <button onClick={page.back}>Back</button> : null }
    try {
      await toolbar.render(<Toolbar />)
      const { machine } = fixture()
      await renderWithAppProviders(harness, <AssistantLibraryVolume assistantId="assistant" machine={machine} kind="capabilities" askInChat={vi.fn()} />)
      await vi.waitFor(() => expect(harness.container.querySelector('[data-testid="assistant-library-item-calendar"]')).not.toBeNull())
      await clickElement(harness.container.querySelector('[data-testid="assistant-library-item-calendar"]')!)
      await vi.waitFor(() => expect(harness.container.textContent).toContain('Original instructions'))
      expect(harness.container.textContent).not.toContain('返回目录')
      expect(toolbar.container.querySelector('button')).not.toBeNull()
      await clickElement([...harness.container.querySelectorAll('button')].find(button => button.textContent?.includes('编辑'))!)
      expect(harness.container.querySelector('[data-testid="assistant-library-editor"]')).not.toBeNull()
      await clickElement(toolbar.container.querySelector('button')!)
      expect(harness.container.querySelector('[data-testid="assistant-library-editor"]')).toBeNull()
      expect(harness.container.textContent).toContain('Original instructions')
      await clickElement(toolbar.container.querySelector('button')!)
      expect(harness.container.querySelector('[data-testid="assistant-library-item-calendar"]')).not.toBeNull()
    } finally { toolbar.cleanup() }
  })
  it('shows groups and independent entries, then opens only that entry by ID', async () => {
    const { machine, entry } = fixture()
    await renderWithAppProviders(harness, <AssistantLibraryVolume assistantId="assistant" machine={machine} kind="capabilities" askInChat={vi.fn()} />)
    await vi.waitFor(() => expect(harness.container.textContent).toContain('查看安排'))
    expect(harness.container.textContent).toContain('工作')
    expect(harness.container.textContent).not.toContain('Aggregate index')
    await clickElement(harness.container.querySelector('[data-testid="assistant-library-item-calendar"]')!)
    await vi.waitFor(() => expect(harness.container.textContent).toContain('Original instructions'))
    expect(entry).toHaveBeenCalledWith('capabilities', 'calendar')
  })
  it('surfaces host failure and rejects the old unstructured response rather than showing false zero', async () => {
    vi.useFakeTimers()
    const { machine, read } = fixture()
    read.mockRejectedValueOnce(new TypeError('Failed to fetch private diagnostic sentinel')).mockResolvedValueOnce({ volume: null, content: null })
    await renderWithAppProviders(harness, <AssistantLibraryVolume assistantId="assistant" machine={machine} kind="capabilities" askInChat={vi.fn()} />)
    await vi.waitFor(() => expect(harness.container.textContent).toContain('暂时读不到'))
    expect(harness.container.textContent).not.toContain('private diagnostic sentinel')
    expect([...harness.container.querySelectorAll('button')].some(node => node.textContent === '重试')).toBe(false)
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(harness.container.textContent).toContain('暂时读不到'))
    expect([...harness.container.querySelectorAll('button')].some(node => node.textContent === '重试')).toBe(false)
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(read).toHaveBeenCalledTimes(2)
    // Malformed stored content is not a transport failure. It stays failed
    // until the resource publisher reports a real change.
    await act(async () => {
      for (const receive of notifications) receive({ extensionId: 'gugu.assistant',server: 'resources',method: 'notifications/resources/updated',params: { resource: 'capabilities' } })
    })
    await vi.waitFor(() => expect(harness.container.textContent).toContain('查看安排'))
  })
  it('counts real entries and does not send the owner to install AutoLibrary', async () => {
    const { machine } = fixture()
    await renderWithAppProviders(harness, <AssistantLibraryCard assistantId={"assistant"} machine={machine} kind="capabilities" onOpen={vi.fn()} />)
    await vi.waitFor(() => expect(harness.container.textContent).toContain('1 条记录'))
    expect(harness.container.textContent).not.toContain('AutoLibrary')
  })
  it('saves an independent entry and preserves input on failed save', async () => {
    const { machine, write, read, appCall } = fixture()
    write.mockRejectedValueOnce(new Error('save failed'))
    await renderWithAppProviders(harness, <AssistantLibraryVolume assistantId="assistant" machine={machine} kind="capabilities" askInChat={vi.fn()} />)
    await vi.waitFor(() => expect(harness.container.textContent).toContain('查看安排'))
    await clickElement([...harness.container.querySelectorAll('button')].find(node => node.textContent === '添加条目')!)
    await typeInto(harness.container.querySelector('input')!, '会议记录')
    await clickElement(harness.container.querySelector('button[type="submit"]')!)
    await vi.waitFor(() => expect(harness.container.querySelector('[role="alert"]')).not.toBeNull())
    expect(harness.container.querySelector('input')!.value).toBe('会议记录')
    await clickElement(harness.container.querySelector('button[type="submit"]')!)
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(2))
    expect(write).toHaveBeenLastCalledWith({ kind: 'capabilities', name: '会议记录', description: '', group: null, content: '' })
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2))
    const sent = appCall.mock.calls.filter(([verb]) => verb === 'dispatch')
    expect(sent).toHaveLength(0)
    expect(savedNotice).toHaveBeenCalledWith(expect.objectContaining({ resource: 'capabilities',operation: 'created',id: 'calendar' }),'assistant',null)
  })

  it('refreshes the open panel when the resource program notifies an Agent edit, without sending an echo', async () => {
    const { machine, read, appCall } = fixture()
    await renderWithAppProviders(harness, <AssistantLibraryVolume assistantId="assistant" machine={machine} kind="capabilities" askInChat={vi.fn()} />)
    await vi.waitFor(() => expect(harness.container.textContent).toContain('查看安排'))
    read.mockResolvedValueOnce({ volume: { kind: 'capabilities' }, items: [{ id: 'calendar', name: 'Agent 改名', description: 'Agent 保存的简介', group: null }] })
    await act(async () => {
      for (const receive of notifications) receive({ extensionId: 'gugu.assistant', server: 'resources', method: 'notifications/resources/updated', params: { resource: 'capabilities' } })
    })
    await vi.waitFor(() => expect(harness.container.textContent).toContain('Agent 保存的简介'))
    expect(appCall.mock.calls.filter(([verb]) => verb === 'dispatch')).toHaveLength(0)
  })

  it('drops the previous assistant editor and its draft when account identity changes', async () => {
    const { machine, read } = fixture()
    await renderWithAppProviders(harness, <AssistantLibraryVolume assistantId="assistant-A" machine={machine} kind="capabilities" askInChat={vi.fn()} />)
    await vi.waitFor(() => expect(harness.container.textContent).toContain('查看安排'))
    await clickElement([...harness.container.querySelectorAll('button')].find(node => node.textContent === '添加条目')!)
    await typeInto(harness.container.querySelector('input')!, 'PRIVATE-ACCOUNT-A-DRAFT')
    read.mockResolvedValue({ volume: { kind: 'capabilities' }, items: [] })
    await renderWithAppProviders(harness, <AssistantLibraryVolume assistantId="assistant-B" machine={machine} kind="capabilities" askInChat={vi.fn()} />)
    await vi.waitFor(() => expect(harness.container.querySelector('[data-testid="assistant-library-editor"]')).toBeNull())
    expect(harness.container.textContent).not.toContain('PRIVATE-ACCOUNT-A-DRAFT')
    await vi.waitFor(() => expect(harness.container.textContent).not.toContain('查看安排'))
  })

})
