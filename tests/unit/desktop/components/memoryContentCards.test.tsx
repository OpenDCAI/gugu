// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { clickElement, createReactHarness, renderWithAppProviders } from '../../../support/testHarness'
import type { MemoryEntry } from '../../../../apps/desktop/src/session/renderer/features/assistant/assistant-machine-core'
import type { AssistantContext } from '../../../../apps/desktop/src/session/renderer/features/assistant/assistant-context'
import type { PhonePageProps } from '../../../../apps/desktop/src/mobile/assistant/MobileAssistantApp'
import '../../../../apps/desktop/src/i18n/registerAssistantCatalog'

const reads = vi.hoisted(() => ({ notes: [] as MemoryEntry[], go: vi.fn() }))
vi.mock('../../../../apps/desktop/src/session/renderer/features/assistant/assistant-data', () => ({
  useMemoryNotes: () => ({ data: { notes: reads.notes }, isLoading: false }), useDirectory: () => ({ data: [], isLoading: false }), useInvalidateAssistant: () => vi.fn(),
}))
vi.mock('../../../../apps/desktop/src/session/renderer/features/assistant/assistant-ui', async () => ({ ...await import('../../../../apps/desktop/src/session/renderer/features/assistant/assistant-ui-parts'), MachineGate: ({ children }: { children: ReactNode }) => children }))
vi.mock('../../../../apps/desktop/src/session/renderer/lib/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }))
vi.mock('../../../../apps/desktop/src/session/renderer/lib/modal/modal-provider', () => ({ useShowModal: () => vi.fn() }))
vi.mock('../../../../apps/desktop/src/session/renderer/lib/ui/markdown-renderer', () => ({ MarkdownRenderer: ({ content }: { content: string }) => content }))
vi.mock('../../../../apps/desktop/src/components/markdown/Markdown', () => ({ Markdown: ({ content }: { content: string }) => content }))
vi.mock('../../../../apps/desktop/src/components/Avatar', () => ({ Avatar: () => null }))
vi.mock('../../../../apps/desktop/src/store/auth', async (original) => ({ ...await original<object>(), useAuth: () => ({ user: null }) }))
vi.mock('../../../../apps/desktop/src/components/assistant/AssistantLibraryVolume', () => ({ AssistantLibraryCard: () => null, AssistantLibraryVolume: () => null }))
vi.mock('../../../../apps/desktop/src/session/renderer/features/assistant/voice-notes/voice-notes-data', () => ({ useVoiceNotes: () => ({ data: [] }) }))
vi.mock('../../../../apps/desktop/src/mobile/assistant/usePhoneRead', () => ({ machineKey: () => 'memory', usePhoneRead: (key: string) => ({ state: 'ok', reload: vi.fn(), data: key?.startsWith('memory-counts') ? { voice: 0, files: 0 } : { notes: reads.notes } }) }))
vi.mock('../../../../apps/desktop/src/mobile/assistant/PhoneMachineView', () => ({ PhoneMachineView: ({ children }: { children: () => ReactNode }) => children(), ReadView: ({ read, children }: { read: { data: unknown }; children: (data: unknown) => ReactNode }) => children(read.data) }))
vi.mock('../../../../apps/desktop/src/mobile/assistant/PhoneFiles', () => ({ PhoneFiles: () => null }))
vi.mock('../../../../apps/desktop/src/mobile/assistant/PhoneVoiceNotes', () => ({ PhoneVoiceNotes: () => null }))
vi.mock('../../../../apps/desktop/src/mobile/assistant/PhoneHealth', () => ({ PhoneHealth: () => null }))
import { AssistantMemoryPage } from '../../../../apps/desktop/src/session/renderer/features/assistant/assistant-memory-page'
import { PhoneMemory } from '../../../../apps/desktop/src/mobile/assistant/PhoneMemory'

const machine = { paths: { resourcesDir: '/assistant/files' }, deviceId: 'fixture-device' }
const secret = '仅供 Agent 检索：事实、依据与推测分开记'
const note = (file: string, body: string, kind: MemoryEntry['kind']): MemoryEntry => ({ file, title: file === 'owner-profile.md' ? '关于主人' : '项目记录', description: secret, body, kind, path: `/memory/${file}`, modifiedAt: '2026-10-01T00:00:00Z' })
let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness(); reads.go.mockReset(); reads.notes = [note('owner-profile.md', '# About you\n## Basic facts\n- **姓名：小林**\n- 喜欢简短的说明', 'user'), note('project.md', '# Project\n- 项目正文事实', 'project')] })
afterEach(() => harness.cleanup())

for (const phone of [false, true]) describe(phone ? 'phone memory content cards' : 'desktop memory content cards', () => {
  const render = async (sub?: string) => {
    const common = { assistant: { id: 'assistant', display_name: '咕咕' }, readiness: 'ready', askInChat: vi.fn(), go: reads.go, homeDeviceId: 'device' }
    if (phone) await renderWithAppProviders(harness, <PhoneMemory {...{ ...common, sub: sub ?? null, machine: { state: 'ready', machine } } as unknown as PhonePageProps} />)
    else await renderWithAppProviders(harness, <AssistantMemoryPage context={{ ...common, route: { tab: 'memory', sub }, machine, machineLoading: false } as unknown as AssistantContext} />)
  }
  it('shows actual body facts in user and sibling cards and keeps their navigation', async () => {
    await render()
    expect(harness.container.textContent).not.toContain(secret)
    expect(harness.container.textContent).toContain('姓名：小林 喜欢简短的说明')
    expect(harness.container.textContent).toContain('项目正文事实')
    expect(harness.container.textContent).not.toContain('Basic facts')
    expect(harness.container.querySelector('[data-testid="assistant-memory-about"] .ta-row-sub')?.getAttribute('data-lines')).toBe('4')
    await clickElement(harness.container.querySelector('[data-testid="assistant-memory-project.md"]')!)
    expect(reads.go).toHaveBeenLastCalledWith(phone ? 'note:project.md' : { tab: 'memory', sub: 'note:project.md' })
  })
  it('falls back to the modification date for a heading-only body', async () => {
    reads.notes = [note('owner-profile.md', '# No facts\n\n## Heading only', 'user')]
    await render()
    const excerpt = harness.container.querySelector('[data-testid="assistant-memory-about"] .ta-row-sub')?.textContent
    expect(excerpt).toBeTruthy()
    expect(excerpt).not.toContain(secret)
    expect(excerpt).not.toContain('Heading only')
    expect(excerpt).toMatch(/更新/)
  })
  it('keeps the detail body intact', async () => {
    await render('note:owner-profile.md')
    expect(harness.container.querySelector('[data-testid="assistant-memory-body"]')?.textContent).toBe(reads.notes[0].body)
    expect(harness.container.textContent).not.toContain(secret)
  })
})
