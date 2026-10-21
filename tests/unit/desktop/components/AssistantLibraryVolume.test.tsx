// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AssistantLibraryCard, AssistantLibraryVolume } from '../../../../apps/desktop/src/components/assistant/AssistantLibraryVolume'
import type { AssistantMachine } from '../../../../apps/desktop/src/session/renderer/features/assistant/assistant-machine-core'
import { assistantPaths } from '../../../../apps/desktop/src/session/renderer/features/assistant/assistant-files'
import { clickElement, createReactHarness, renderWithAppProviders, typeInto } from '../../../support/testHarness'
import '../../../../apps/desktop/src/i18n/registerAssistantCatalog'

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => harness.cleanup())
function fixture() {
  const volume = { kind: 'capabilities', name: 'capabilities', path: '/gugu/library/capabilities', index: '/gugu/library/capabilities' }
  const item = { id: 'calendar', name: '日历', description: '查看安排', group: '工作', path: '/gugu/library/capabilities/calendar', index: '/gugu/library/capabilities/calendar/index.json', modifiedAt: '2026-10-20T00:00:00Z' }
  const read = vi.fn().mockResolvedValue({ volume, content: 'Aggregate index is not the UI', items: [item] })
  const entry = vi.fn().mockResolvedValue({ ...item, content: '# Original instructions' })
  const write = vi.fn().mockResolvedValue({ ...item, content: '' })
  const machine = { deviceId: 'owned-device', projectId: 'project', workspaceId: 'workspace', home: '/owner', paths: assistantPaths('/owner', '/owner/assistant', 'computer'), rpc: { app: { getUserLibraryVolume: read, readUserLibraryEntry: entry, writeUserLibraryEntry: write } } } as unknown as AssistantMachine
  return { machine, read, entry, write }
}

describe('Gugu structured capabilities', () => {
  it('shows groups and independent entries, then opens only that entry by ID', async () => {
    const { machine, entry } = fixture()
    await renderWithAppProviders(harness, <AssistantLibraryVolume machine={machine} kind="capabilities" askInChat={vi.fn()} />)
    await vi.waitFor(() => expect(harness.container.textContent).toContain('查看安排'))
    expect(harness.container.textContent).toContain('工作')
    expect(harness.container.textContent).not.toContain('Aggregate index')
    await clickElement(harness.container.querySelector('[data-testid="assistant-library-item-calendar"]')!)
    await vi.waitFor(() => expect(harness.container.textContent).toContain('Original instructions'))
    expect(entry).toHaveBeenCalledWith('capabilities', 'calendar')
  })
  it('surfaces host failure and rejects the old unstructured response rather than showing false zero', async () => {
    const { machine, read } = fixture()
    read.mockRejectedValueOnce(new Error('private diagnostic sentinel')).mockResolvedValueOnce({ volume: null, content: null })
    await renderWithAppProviders(harness, <AssistantLibraryVolume machine={machine} kind="capabilities" askInChat={vi.fn()} />)
    await vi.waitFor(() => expect(harness.container.textContent).toContain('暂时读不到资源'))
    expect(harness.container.textContent).not.toContain('private diagnostic sentinel')
    await clickElement([...harness.container.querySelectorAll('button')].find(node => node.textContent === '重试')!)
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(harness.container.textContent).toContain('暂时读不到资源'))
    await clickElement([...harness.container.querySelectorAll('button')].find(node => node.textContent === '重试')!)
    await vi.waitFor(() => expect(harness.container.textContent).toContain('查看安排'))
  })
  it('counts real entries and does not send the owner to install AutoLibrary', async () => {
    const { machine } = fixture()
    await renderWithAppProviders(harness, <AssistantLibraryCard machine={machine} kind="capabilities" onOpen={vi.fn()} />)
    await vi.waitFor(() => expect(harness.container.textContent).toContain('1 条记录'))
    expect(harness.container.textContent).not.toContain('AutoLibrary')
  })
  it('saves an independent entry and preserves input on failed save', async () => {
    const { machine, write, read } = fixture()
    write.mockRejectedValueOnce(new Error('save failed'))
    await renderWithAppProviders(harness, <AssistantLibraryVolume machine={machine} kind="capabilities" askInChat={vi.fn()} />)
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
  })

})
