// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PhoneMemory } from '../../../apps/desktop/src/mobile/assistant/PhoneMemory'
import { PhoneFiles } from '../../../apps/desktop/src/mobile/assistant/PhoneFiles'
import { PhoneVoiceNotes } from '../../../apps/desktop/src/mobile/assistant/PhoneVoiceNotes'
import { PhoneRoutineDetail } from '../../../apps/desktop/src/mobile/assistant/PhoneRoutineDetail'
import { clickElement, createNode, createReactHarness, renderWithAppProviders } from '../../support/testHarness'
import { expectExit, frame, holdDialogExit } from '../../support/dialogExit'

const m = vi.hoisted(() => ({ data: {} as Record<string, unknown>, remove: vi.fn(async () => undefined), reload: vi.fn(), refresh: vi.fn(async () => undefined) }))
vi.mock('../../../apps/desktop/src/mobile/assistant/usePhoneRead', async (original) => ({
  ...await original<typeof import('../../../apps/desktop/src/mobile/assistant/usePhoneRead')>(),
  usePhoneRead: (key: string | null) => ({ state: 'ok', data: m.data[key?.split('|')[0] ?? 'none'] ?? null, reload: m.reload, refresh: m.refresh }),
}))
vi.mock('../../../apps/desktop/src/mobile/assistant/usePhoneRoutines', () => ({ usePhoneRoutines: () => ({
  routines: [{ id: 'routine-1', name: 'Routine', enabled: false, triggerConfig: { expr: '0 9 * * *' }, agentConfig: {} }],
  read: { state: 'ok', data: [], reload: m.reload },
  // Not a shared computer home: no session directory is part of the ownership read.
  directory: null,
}) }))
vi.mock('../../../apps/desktop/src/mobile/assistant/phoneMemoryData', async (original) => ({
  ...await original<typeof import('../../../apps/desktop/src/mobile/assistant/phoneMemoryData')>(), deleteMemoryNote: m.remove,
}))
vi.mock('../../../apps/desktop/src/mobile/assistant/phoneVoiceNotesData', async (original) => ({
  ...await original<typeof import('../../../apps/desktop/src/mobile/assistant/phoneVoiceNotesData')>(), deleteVoiceNote: m.remove,
}))
vi.mock('../../../apps/desktop/src/session/renderer/features/assistant/assistant-machine-core', async (original) => ({
  ...await original<typeof import('../../../apps/desktop/src/session/renderer/features/assistant/assistant-machine-core')>(), removePath: m.remove,
}))
vi.mock('../../../apps/desktop/src/mobile/agent-watch/sessionpage-rpc', () => ({
  machineRpc: () => ({ automations: { deleteAutomation: m.remove } }), onMachineEvent: () => () => {},
}))
vi.mock('../../../apps/desktop/src/components/markdown/Markdown', () => ({ Markdown: () => null }))

let h: ReturnType<typeof createReactHarness>
let exit: ReturnType<typeof holdDialogExit>
beforeEach(() => {
  h = createReactHarness(); exit = holdDialogExit(); vi.clearAllMocks()
  m.data = {
    memory: { notes: [{ file: 'note.md', title: 'Memory', body: 'Remember', kind: 'user', path: '/memory/note.md' }] },
    files: { kind: 'file', entry: { path: '/resources/file.txt', name: 'file.txt', size: 12 }, content: { kind: 'text', text: 'File contents' } },
    'voice-note': { item: { id: 'voice-1', title: 'Voice', meta: null, view: { kind: 'queued' } }, summary: '', lines: [] },
  }
})
afterEach(() => { h.cleanup(); delete (HTMLElement.prototype as Partial<HTMLElement>).getAnimations })

const machine = { deviceId: 'device-1', projectId: 'project-1', workspaceId: 'workspace-1', home: '/home/test', paths: { memoryDir: '/memory' },
  rpc: { workspace: { files: {
    watchDirectory: vi.fn(async () => ({ success: true, data: { leaseId: 'memory-view' } })),
    releaseDirectoryWatch: vi.fn(async () => undefined),
  } } } }
const cases = [
  { label: 'memory', component: PhoneMemory, props: { sub: 'note:note.md' }, open: 'assistant-memory-delete', dialog: 'assistant-memory-delete-dialog' },
  { label: 'file', component: PhoneFiles, props: { sub: 'files:file.txt', trail: ['file.txt'] }, open: 'assistant-file-delete', dialog: 'assistant-file-delete-dialog' },
  { label: 'voice note', component: PhoneVoiceNotes, props: { sub: 'voice:voice-1' }, open: 'assistant-voice-delete', dialog: 'assistant-voice-delete-dialog' },
  { label: 'routine', component: PhoneRoutineDetail, props: { id: 'routine-1' }, open: 'assistant-routine-delete', dialog: 'assistant-routine-delete-dialog' },
]
for (const c of cases) it(`${c.label}: the actual page stays mounted until confirmation exit, then navigates`, async () => {
  const go = vi.fn()
  await renderWithAppProviders(h, createNode(c.component, {
    assistant: { id: 'agent-1', display_name: 'Assistant' }, homeDeviceId: 'device-1', readiness: 'ready', machine: { state: 'ready', machine }, go, askInChat: vi.fn(), ...c.props,
  }), { toast: vi.fn() })
  await clickElement(document.querySelector(`[data-testid="${c.open}"]`)!); await frame()
  const popup = document.querySelector<HTMLElement>(`[data-testid="${c.dialog}"]`)!
  await clickElement(document.querySelector(`[data-testid="${c.dialog}-confirm"]`)!)
  expect(m.remove).toHaveBeenCalledOnce()
  expect(go).not.toHaveBeenCalled()
  await expectExit(popup, exit)
  expect(go).toHaveBeenCalledOnce()
})
