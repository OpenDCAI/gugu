// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { clickElement, createReactHarness, renderWithAppProviders } from '../../../support/testHarness'
import type { AssistantContext } from '../../../../apps/desktop/src/session/renderer/features/assistant/assistant-context'
import '../../../../apps/desktop/src/i18n/registerAssistantCatalog'

const reads = vi.hoisted(() => ({ today: vi.fn(), entries: [{ name: '项目资料', path: '/assistant/资料/项目资料', type: 'directory', size: 0 }], ask: vi.fn(), go: vi.fn() }))
vi.mock('../../../../apps/desktop/src/session/renderer/features/assistant/assistant-data', () => ({
  useDirectory: () => ({ data: reads.entries, isSuccess: true, isLoading: false }),
  useMemoryNotes: () => ({ data: { notes: [] }, isLoading: false }),
  useInvalidateAssistant: () => vi.fn(),
  useTodayFile: reads.today,
}))
vi.mock('../../../../apps/desktop/src/session/renderer/features/assistant/assistant-personality', () => ({ usePersona: () => ({ preset: null, rest: '' }), CustomizeDialog: () => null }))
vi.mock('../../../../apps/desktop/src/session/renderer/features/assistant/assistant-shell', () => ({ ShellSlot: () => null }))
vi.mock('../../../../apps/desktop/src/components/Avatar', () => ({ Avatar: () => null }))
vi.mock('../../../../apps/desktop/src/components/assistant/AssistantNameInline', () => ({ AssistantNameInline: ({ name }: { name: string }) => name }))
vi.mock('../../../../apps/desktop/src/components/assistant/AssistantLibraryVolume', () => ({ AssistantLibraryCard: () => null, AssistantLibraryVolume: () => null }))
vi.mock('../../../../apps/desktop/src/session/renderer/features/assistant/assistant-ui', async () => ({
  ...await import('../../../../apps/desktop/src/session/renderer/features/assistant/assistant-ui-parts'),
  MachineGate: ({ children }: { children: ReactNode }) => children,
}))
vi.mock('../../../../apps/desktop/src/session/renderer/lib/ui/markdown-renderer', () => ({ MarkdownRenderer: ({ content }: { content: string }) => content }))
vi.mock('../../../../apps/desktop/src/session/renderer/lib/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }))
vi.mock('../../../../apps/desktop/src/session/renderer/lib/modal/modal-provider', () => ({ useShowModal: () => vi.fn() }))
vi.mock('../../../../apps/desktop/src/session/renderer/features/assistant/voice-notes/voice-notes-data', () => ({ useVoiceNotes: () => ({ data: [] }) }))
import { AssistantProfilePage } from '../../../../apps/desktop/src/session/renderer/features/assistant/assistant-profile'
import { AssistantMemoryPage } from '../../../../apps/desktop/src/session/renderer/features/assistant/assistant-memory-page'
import { AssistantTodayPage } from '../../../../apps/desktop/src/session/renderer/features/assistant/assistant-today'

let harness: ReturnType<typeof createReactHarness>
function context(tab: 'profile' | 'memory' | 'today', sub?: string): AssistantContext {
  return { assistant: { id: 'assistant', display_name: '咕咕', avatar: null, created_at: null }, ownerName: '主人', homeDeviceId: 'device',
    chatId: 'chat', machine: { paths: { resourcesDir: '/assistant/资料' } }, machineLoading: false, readiness: 'ready', route: { tab, sub },
    go: reads.go, askInChat: reads.ask } as unknown as AssistantContext
}
const diary = { id: 'diary-1', kind: 'diary', localDate: '2026-10-26', pushedAt: null, messageId: null,
  cards: [{ id: 'diary-body', title: '今天的日记', markdown: '日记全文：今天记住的完整内容。' }] }
beforeEach(() => {
  harness = createReactHarness(); vi.clearAllMocks()
  reads.today.mockReturnValue({ isLoading: false, isError: false, data: { state: 'ok', file: { version: 1, batches: [diary],
    widgets: [{ id: 'tracking', title: '不应出现的追踪卡', markdown: '隐藏组件正文', state: 'ready', schedule: null, updatedAt: null }], day: { state: 'none' }, ideas: { state: 'none' } } } })
})
afterEach(() => harness.cleanup())

describe('assistant panel organization', () => {
  it('moves the upload entry and resource folder to the profile and removes the diary section', async () => {
    await renderWithAppProviders(harness, <AssistantProfilePage context={context('profile')} />)
    expect(harness.container.querySelector('[data-testid="assistant-profile-add"]')).not.toBeNull()
    expect(harness.container.querySelector('[data-testid="assistant-profile-files"]')).not.toBeNull()
    expect(harness.container.querySelector('[data-testid="assistant-diaries"]')).toBeNull()
    expect(reads.today).not.toHaveBeenCalled()
    await clickElement(harness.container.querySelector('[data-testid="assistant-profile-add"]')!)
    expect(reads.go).toHaveBeenLastCalledWith({ tab: 'profile', sub: 'files' })
    await clickElement(harness.container.querySelector('[data-testid="assistant-profile-files"]')!)
    expect(reads.go).toHaveBeenLastCalledWith({ tab: 'profile', sub: 'files' })
    await renderWithAppProviders(harness, <AssistantMemoryPage context={context('memory')} />)
    expect(harness.container.querySelector('[data-testid="assistant-memory-add"]')).toBeNull()
    expect(harness.container.querySelector('[data-testid="assistant-memory-files"]')).toBeNull()
  })

  it('keeps resource uploads and nested folder navigation in the profile tab', async () => {
    await renderWithAppProviders(harness, <AssistantProfilePage context={context('profile', 'files')} />)
    expect(harness.container.querySelector('[data-testid="assistant-files-upload"]')).not.toBeNull()
    expect(harness.container.querySelector('input[type="file"]')).not.toBeNull()
    expect(harness.container.querySelector('button button')).toBeNull()
    await clickElement(harness.container.querySelector('[data-testid="assistant-file-项目资料"] .ta-row-main')!)
    expect(reads.go).toHaveBeenLastCalledWith({ tab: 'profile', sub: 'files:项目资料' })
    expect(reads.ask).not.toHaveBeenCalled()
  })

  it('hides existing and empty widget surfaces, while a diary opens its full text from activity', async () => {
    await renderWithAppProviders(harness, <AssistantTodayPage context={context('today')} />)
    expect(harness.container.textContent).not.toContain('不应出现的追踪卡')
    expect(harness.container.textContent).not.toContain('添加组件')
    expect(harness.container.textContent).not.toContain('小组件')
    await clickElement(harness.container.querySelector('[data-testid="assistant-open-diary-diary-1"]')!)
    expect(reads.go).toHaveBeenLastCalledWith({ tab: 'today', sub: 'diary:diary-1' })
    expect(reads.ask).not.toHaveBeenCalled()
    await renderWithAppProviders(harness, <AssistantTodayPage context={context('today', 'diary:diary-1')} />)
    expect(harness.container.textContent).toContain('日记全文：今天记住的完整内容。')
    reads.today.mockReturnValue({ isLoading: false, isError: false, data: { state: 'ok', file: { version: 1, batches: [], widgets: [], day: { state: 'none' }, ideas: { state: 'none' } } } })
    await renderWithAppProviders(harness, <AssistantTodayPage context={context('today')} />)
    expect(harness.container.textContent).not.toContain('添加组件')
    expect(harness.container.textContent).not.toContain('小组件')
  })

  it('keeps old diary deep links readable after removing the profile diary list', async () => {
    await renderWithAppProviders(harness, <AssistantProfilePage context={context('profile', 'diary:diary-1')} />)
    expect(harness.container.textContent).toContain('日记全文：今天记住的完整内容。')
    expect(reads.ask).not.toHaveBeenCalled()
  })
})
