// @vitest-environment jsdom
import { act, createElement } from 'react'
import { notifyManager } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'
import { ProjectFileSettings } from '../../../../apps/desktop/src/components/chat/ProjectFileSettings'
import { attachmentQueryClient } from '../../../../apps/desktop/src/lib/attachmentQueryClient'

const f = vi.hoisted(() => ({ rpc: vi.fn(), projects: vi.fn(), user: { id: 'owner' } as { id: string } | null }))
vi.mock('@/lib/supabase', () => ({ chatDb: { rpc: f.rpc } }))
vi.mock('@/lib/deviceProjects', () => ({ listMyDeviceProjects: f.projects }))
vi.mock('@/store/auth', () => ({ useAuth: () => ({ user: f.user }) }))
vi.mock('@/session/renderer/features/projects/stores/project-groups-store', () => ({ projectGroupsStore: { projectOfChat: () => 'actual-project' } }))
vi.mock('react-i18next', async (importOriginal) => ({ ...await importOriginal<object>(), useTranslation: () => ({ t: (key: string) => key }) }))
const policy = { host_device_id: 'actual-device', host_project_id: 'actual-project', proactive_upload: false, temporary_transfer: true, retention: '7d' }
describe('project file settings are persistent metadata and never a download', () => {
  let harness: ReturnType<typeof createReactHarness>
  beforeEach(() => {
    harness = createReactHarness(); attachmentQueryClient.clear(); vi.clearAllMocks(); f.user = { id: 'owner' }
    notifyManager.setNotifyFunction(callback => { act(callback) })
    f.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => ({ error: null, data: name.endsWith('_for') ? policy : {
      host_device_id: args.p_device, host_project_id: args.p_project, proactive_upload: args.p_upload, temporary_transfer: args.p_temporary, retention: args.p_retention,
    } }))
    f.projects.mockResolvedValue({ 'actual-device': [{ localProjectId: 'actual-project', chatId: 'group' }] })
  })
  afterEach(() => { harness.cleanup(); attachmentQueryClient.clear(); notifyManager.setNotifyFunction(callback => { callback() }) })
  const switches = () => [...harness.container.querySelectorAll<HTMLButtonElement>('button[role="switch"]')]
  async function render() {
    await harness.render(createElement(ProjectFileSettings, { chatId: 'group' }))
    await vi.waitFor(() => expect(switches()).toHaveLength(2))
  }
  it('loads defaults and saves the exact host binding; display never signs or reserves a download', async () => {
    await render()
    expect(switches()[0]!.getAttribute('aria-checked')).toBe('false')
    expect(switches()[1]!.getAttribute('aria-checked')).toBe('true')
    expect(f.rpc.mock.calls).toEqual([['file_project_policy_for', { p_chat: 'group', p_as: 'owner' }]])
    await act(async () => { switches()[0]!.click() })
    await vi.waitFor(() => expect(switches()[0]!.getAttribute('aria-checked')).toBe('true'))
    expect(f.rpc.mock.calls[1]).toEqual(['file_project_policy_as', { p_chat: 'group', p_device: 'actual-device', p_project: 'actual-project', p_upload: true, p_temporary: true, p_retention: '7d' }])
    expect(harness.container.textContent).toContain('group.settings.fileStrictHint')
    expect(f.rpc.mock.calls.every(([name]) => /^file_project_policy_(for|as)$/.test(name))).toBe(true)
  })
  it('uses the actual account project binding for an unset policy', async () => {
    f.rpc.mockResolvedValueOnce({ data: null, error: null })
    await render()
    await act(async () => { switches()[1]!.click() })
    await vi.waitFor(() => expect(f.rpc).toHaveBeenCalledTimes(2))
    expect(f.rpc.mock.calls[1]![1]).toMatchObject({ p_device: 'actual-device', p_project: 'actual-project', p_upload: false, p_temporary: false })
    expect(f.projects).toHaveBeenCalledOnce()
  })
  it('keeps the persisted value and shows a refusal when an unauthorized save fails', async () => {
    await render(); f.rpc.mockResolvedValueOnce({ data: null, error: { message: 'Only the bound project owner can change file policy' } })
    await act(async () => { switches()[0]!.click() })
    await vi.waitFor(() => expect(harness.container.querySelector('[role="alert"]')?.textContent).toContain('group.settings.saveFailed'))
    expect(switches()[0]!.getAttribute('aria-checked')).toBe('false')
  })
  it('does not fabricate defaults after a load failure; retry must retrieve real metadata', async () => {
    f.rpc.mockResolvedValueOnce({ data: null, error: { message: 'unavailable' } })
    await harness.render(createElement(ProjectFileSettings, { chatId: 'group' }))
    await vi.waitFor(() => expect(harness.container.querySelector('[role="alert"]')).not.toBeNull())
    expect(switches()).toHaveLength(0)
    await act(async () => { harness.container.querySelector<HTMLButtonElement>('button')!.click() })
    await vi.waitFor(() => expect(switches()).toHaveLength(2))
    expect(f.projects).not.toHaveBeenCalled()
  })
})
