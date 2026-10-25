// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useChatDraft } from '../../../../apps/desktop/src/components/chat/useChatDraft'

const mocked = vi.hoisted(() => ({ snapshot: {} as Record<string, unknown>, listeners: new Set<() => void>() }))
vi.mock('../../../../apps/desktop/src/store/chatContext', async () => {
  const { useSyncExternalStore } = await import('react')
  return { useChatStore: () => useSyncExternalStore((listener) => { mocked.listeners.add(listener); return () => mocked.listeners.delete(listener) }, () => mocked.snapshot) }
})
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const api = new Map<string, ReturnType<typeof useChatDraft>>()
function Composer({ id }: { id: string }) { const value = useChatDraft(id); api.set(id, value); return <output data-chat={id}>{value.text}</output> }
const update = (field: string, key: string, value: unknown) => {
  const previous = mocked.snapshot[field] as Record<string, unknown>
  mocked.snapshot = { ...mocked.snapshot, [field]: { ...previous, [key]: value } }
  for (const listener of mocked.listeners) listener()
}
let root: Root, container: HTMLDivElement
beforeEach(async () => {
  vi.useFakeTimers()
  mocked.snapshot = { drafts: {}, draftMentions: {}, draftAttachments: {},
    setDraft: (key: string, value: unknown) => update('drafts', key, value),
    setDraftMentions: (key: string, value: unknown) => update('draftMentions', key, value),
    setDraftAttachments: (key: string, value: unknown) => update('draftAttachments', key, value),
  }
  container = document.createElement('div'); root = createRoot(container)
  await act(async () => root.render(<><Composer id="assistant" /><Composer id="task" /></>))
})
afterEach(async () => { await act(async () => root.unmount()); vi.useRealTimers(); api.clear() })

describe('two simultaneous conversation drafts', () => {
  it('keeps unsaved typing when the other pane saves, then persists each pane separately', async () => {
    await act(async () => api.get('assistant')!.setText('左侧草稿'))
    await act(async () => vi.advanceTimersByTime(150))
    await act(async () => api.get('task')!.setText('右侧草稿'))
    await act(async () => vi.advanceTimersByTime(150)) // only the left pane reaches its save boundary
    expect(api.get('task')!.text).toBe('右侧草稿')
    await act(async () => vi.advanceTimersByTime(150))
    expect(mocked.snapshot.drafts).toEqual({ assistant: '左侧草稿', task: '右侧草稿' })
  })
  it('accepts an external change to its own text without overwriting the other pane', async () => {
    await act(async () => api.get('task')!.setText('未保存的字'))
    await act(async () => update('drafts', 'assistant', '来自助理页的建议'))
    expect(api.get('task')!.text).toBe('未保存的字')
    expect(api.get('assistant')!.text).toBe('来自助理页的建议')
  })
})
