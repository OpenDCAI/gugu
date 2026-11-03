// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMessageFind } from '../../../../apps/desktop/src/components/chat/messageFind'
import { locateFindRange, paintFindHighlight } from '@gugu/session-chat-ui/find-highlight'
import { chatDb } from '../../../../apps/desktop/src/lib/supabase'
import type { MessageItem } from '@gugu/core/shared/types/chat'

const network = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }))
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({ chatDb: network }))
const message = (id: string, content: string, extra: Partial<MessageItem> = {}) => ({ id, content, content_type: 'text', ...extra }) as MessageItem
let host: HTMLDivElement
let frames: Map<number, FrameRequestCallback>
let highlights: Map<string, Set<Range>>
let nextFrame = 0
const painted = () => highlights.get('gugu-chat-find')?.values().next().value
function flush() {
  const pending = [...frames.values()]; frames.clear()
  pending.forEach(callback => callback(0))
}
function row(id: string, text: string) {
  const div = document.createElement('div'); div.dataset.msgId = id
  const body = document.createElement('span'); body.dataset.messageFindContent = ''; body.textContent = text
  div.append(body); host.append(div)
  return div
}
beforeEach(() => {
  host = document.createElement('div'); document.body.append(host)
  frames = new Map(); highlights = new Map()
  vi.stubGlobal('CSS', { escape: (s: string) => s, highlights })
  vi.stubGlobal('Highlight', class extends Set<Range> { constructor(range: Range) { super([range]) } })
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { const id = ++nextFrame; frames.set(id, cb); return id })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  // Prove this is the live mocked boundary before interpreting its subsequent zero count.
  chatDb.rpc('instrument-positive-control'); expect(network.rpc).toHaveBeenCalledOnce()
  network.rpc.mockClear(); network.from.mockClear()
})
afterEach(() => { host.remove(); vi.unstubAllGlobals() })

describe('loaded message find', () => {
  it('k2 counts body and attachment names, skips retractions, wraps both ways and makes zero chatDb requests', () => {
    const messages = [message('first', '**Needle** then NEEDLE'), message('other', 'context stays'),
      message('file', '[附件] needle.txt (text/plain)\n[Size] 12\n[Kind] file', { content_type: 'attachment' }),
      message('gone', 'needle', { retracted_at: '2026-11-02' })]
    const rows = messages.map(message => ({ type: 'message', message }))
    row('first', 'Needle then NEEDLE'); row('other', 'context stays'); row('file', 'needle.txt')
    const scrollToIndex = vi.fn()
    const backend = createMessageFind({ messages, rows, root: () => host, list: () => ({ scrollToIndex, autoscrollToBottom: vi.fn() }), scroller: () => host })
    expect(backend.find('needle')).toEqual({ currentIndex: 1, total: 3 }); flush()
    expect(painted()?.toString()).toBe('Needle')
    expect(backend.step('prev')).toEqual({ currentIndex: 3, total: 3 }); flush()
    expect(painted()?.toString()).toBe('needle')
    expect(backend.step('next')).toEqual({ currentIndex: 1, total: 3 })
    expect(backend.step('next')).toEqual({ currentIndex: 2, total: 3 }); flush()
    expect(painted()?.toString()).toBe('NEEDLE')
    expect(host.textContent).toContain('context stays')
    expect(network.from).not.toHaveBeenCalled(); expect(network.rpc).not.toHaveBeenCalled()
    backend.clear(); expect(painted()).toBeUndefined(); expect(frames.size).toBe(0)
  })

  it('k3 locates an initially unmounted loaded row via the local list handle and paints it without network', () => {
    const messages = [message('offscreen', 'Loaded needle'), message('tail', 'tail context')]
    row('tail', 'tail context')
    const scrollToIndex = vi.fn(() => { row('offscreen', 'Loaded needle') })
    const backend = createMessageFind({ messages, rows: messages.map(message => ({ type: 'message', message })),
      root: () => host, list: () => ({ scrollToIndex, autoscrollToBottom: vi.fn() }), scroller: () => host })
    expect(host.querySelector('[data-msg-id=offscreen]')).toBeNull()
    expect(backend.find('needle')).toEqual({ currentIndex: 1, total: 1 })
    expect(scrollToIndex).toHaveBeenCalledWith({ index: 0, align: 'center', behavior: 'auto' })
    flush(); expect(painted()?.toString()).toBe('needle')
    expect(painted()?.startContainer.parentElement?.closest('[data-msg-id]')?.getAttribute('data-msg-id')).toBe('offscreen')
    expect(network.from).not.toHaveBeenCalled(); expect(network.rpc).not.toHaveBeenCalled()
    backend.clear()
  })

  it('searches card words and ignores attachment and card transport metadata', () => {
    const card = JSON.stringify({ v: 1, type: 'task', text: 'Visible body', agentUserId: 'hidden-needle', agentName: 'Agent',
      sessionId: 'session', projectId: 'project', deviceId: 'device', machineLabel: 'machine' })
    const messages = [message('card', card, { content_type: 'card' }),
      message('file', '[附件] brief.txt (text/needle)\n[Size] 12\n[Kind] file', { content_type: 'attachment' })]
    const backend = createMessageFind({ messages, rows: messages.map(message => ({ type: 'message', message })),
      root: () => host, list: () => null, scroller: () => host })
    expect(backend.find('needle')).toEqual({ currentIndex: 0, total: 0 })
    expect(backend.find('Visible')).toEqual({ currentIndex: 1, total: 1 })
    backend.clear()
    expect(network.from).not.toHaveBeenCalled(); expect(network.rpc).not.toHaveBeenCalled()
  })

  it('shares range mapping across markup and protects a newer painter from an older clear', () => {
    const div = row('one', ''); div.innerHTML = '<span data-message-find-content>NEE<strong>DLE</strong></span>'
    const range = locateFindRange(div, 'needle', 0)!
    expect(range.toString()).toBe('NEEDLE')
    const old = {}, current = {}
    paintFindHighlight(document, old, range); paintFindHighlight(document, current, range)
    paintFindHighlight(document, old, null); expect(painted()).toBe(range)
    paintFindHighlight(document, current, null); expect(painted()).toBeUndefined()
  })

  it('owns highlights independently in each document', () => {
    const first = row('first', 'first'), iframe = document.createElement('iframe'); host.append(iframe)
    const other = iframe.contentDocument!, otherHighlights = new Map<string, Set<Range>>()
    Object.defineProperty(other.defaultView, 'CSS', { configurable: true, value: { highlights: otherHighlights } })
    Object.defineProperty(other.defaultView, 'Highlight', { configurable: true, value: class extends Set<Range> { constructor(range: Range) { super([range]) } } })
    other.body.textContent = 'second'
    const firstRange = document.createRange(); firstRange.selectNodeContents(first)
    const secondRange = other.createRange(); secondRange.selectNodeContents(other.body)
    const owner = {}
    paintFindHighlight(document, owner, firstRange); paintFindHighlight(other, owner, secondRange)
    paintFindHighlight(document, owner, null)
    expect(painted()).toBeUndefined()
    expect(otherHighlights.get('gugu-chat-find')?.has(secondRange)).toBe(true)
    paintFindHighlight(other, owner, null)
    expect(otherHighlights.size).toBe(0)
  })
})
