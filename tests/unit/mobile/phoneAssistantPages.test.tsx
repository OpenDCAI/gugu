// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '../../../apps/desktop/src/i18n/registerAssistantCatalog'
import { PhoneFiles } from '../../../apps/desktop/src/mobile/assistant/PhoneFiles'
import { PhoneVoiceNotes } from '../../../apps/desktop/src/mobile/assistant/PhoneVoiceNotes'
import type { PhonePageProps } from '../../../apps/desktop/src/mobile/assistant/MobileAssistantApp'
import type { PhoneVoiceDetail } from '../../../apps/desktop/src/mobile/assistant/phoneVoiceNotesData'
import { assistantPaths } from '../../../apps/desktop/src/session/renderer/features/assistant/assistant-files'
import type { AssistantMachine } from '../../../apps/desktop/src/session/renderer/features/assistant/assistant-machine-core'
import { clickElement, createReactHarness, deferred, renderWithAppProviders } from '../../support/testHarness'

const mocks = vi.hoisted(() => ({ files: vi.fn(), upload: vi.fn(), voice: vi.fn() }))
vi.mock('../../../apps/desktop/src/mobile/assistant/phoneMemoryData', async (original) => ({
  ...await original<object>(), readResourceView: mocks.files, uploadResources: mocks.upload,
}))
vi.mock('../../../apps/desktop/src/mobile/assistant/phoneVoiceNotesData', async (original) => ({
  ...await original<object>(), readVoiceNote: mocks.voice,
}))
vi.mock('../../../apps/desktop/src/components/markdown/Markdown', () => ({ Markdown: ({ content }: { content: string }) => content }))

const machine: AssistantMachine = {
  deviceId: 'home', projectId: 'project', workspaceId: 'workspace', home: '/home/owner',
  rpc: {} as AssistantMachine['rpc'], paths: assistantPaths('/home/owner', '/home/owner/project'),
}
const page = (): PhonePageProps => ({
  assistant: { id: 'assistant', display_name: '咕咕', avatar: null, created_at: null },
  chatId: 'assistant-dm', ownerName: 'Owner', home: { kind: 'cloud', deviceId: 'home' },
  machine: { state: 'ready', machine }, homeDeviceId: 'home', cloudDeviceId: 'home', readiness: 'ready',
  askInChat: vi.fn(), sub: null, go: vi.fn(), open: vi.fn(),
})

describe('phone assistant data flows', () => {
  let harness: ReturnType<typeof createReactHarness>
  beforeEach(() => {
    harness = createReactHarness()
    mocks.files.mockReset().mockResolvedValue({ kind: 'folder', entries: [] })
    mocks.upload.mockReset()
    mocks.voice.mockReset()
  })
  afterEach(() => { harness.cleanup(); vi.useRealTimers() })
  async function chooseFile(name = 'schedule.md') {
    const input = harness.container.querySelector<HTMLInputElement>('[data-testid="assistant-files-input"]')!
    expect(input).not.toBeNull()
    await act(async () => {
      Object.defineProperty(input, 'files', { configurable: true, value: [new File(['# Schedule'], name)] })
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
  }

  it('keeps the completed-upload action after reloading the directory, and fills the right chat draft', async () => {
    const props = page()
    mocks.upload.mockResolvedValue({ done: ['schedule.md'], rejected: [], failed: [] })
    await renderWithAppProviders(harness, <PhoneFiles {...props} trail={[]} />)
    await chooseFile()
    expect(mocks.files).toHaveBeenCalledTimes(2)
    const analyze = harness.container.querySelector<HTMLElement>('[data-testid="assistant-files-analyze"]')
    expect(analyze).not.toBeNull()
    expect(harness.container.textContent).toContain('schedule.md')
    await clickElement(analyze!)
    expect(props.askInChat).toHaveBeenCalledWith(expect.stringContaining('schedule.md'))
    expect(harness.container.querySelector('[data-testid="assistant-files-analyze"]')).toBeNull()
  })

  it('does not move a completed upload into a different folder after navigation', async () => {
    const uploading = deferred<{ done: string[]; rejected: []; failed: [] }>()
    mocks.upload.mockReturnValue(uploading.promise)
    const props = page()
    await renderWithAppProviders(harness, <PhoneFiles {...props} trail={[]} />)
    await chooseFile()
    await renderWithAppProviders(harness, <PhoneFiles {...props} trail={['other']} />)
    expect(mocks.files).toHaveBeenLastCalledWith(machine, ['other'])
    await act(async () => { uploading.resolve({ done: ['schedule.md'], rejected: [], failed: [] }) })
    expect(harness.container.querySelector('[data-testid="assistant-files-analyze"]')).toBeNull()
    expect(harness.container.querySelector('[data-testid="assistant-files-upload"]')?.textContent).not.toContain('schedule.md')
  })

  it('refreshes an opened queued voice note when transcription begins elsewhere', async () => {
    vi.useFakeTimers()
    const queued: PhoneVoiceDetail = {
      item: { id: 'note', title: '会议', createdAt: '2026-10-21T00:00:00Z', meta: null, view: { kind: 'queued' } },
      summary: null, lines: [],
    }
    mocks.voice.mockResolvedValueOnce(queued).mockResolvedValueOnce({
      ...queued, item: { ...queued.item, view: { kind: 'ready', title: '会议' } }, summary: '# 会议\n已整理的总结',
    })
    await renderWithAppProviders(harness, <PhoneVoiceNotes {...page()} sub="voice:note" />)
    expect(harness.container.querySelector('[data-testid="assistant-voice-queued"]')).not.toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    expect(mocks.voice).toHaveBeenCalledTimes(2)
    expect(harness.container.querySelector('[data-testid="assistant-voice-summary"]')?.textContent).toContain('已整理的总结')
    expect(harness.container.querySelector('[data-testid="assistant-voice-queued"]')).toBeNull()
  })
})
