// @vitest-environment jsdom
import { act, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { observable, runInAction } from 'mobx'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatView, TranscriptTurn } from '@gugu/session-chat-ui'
import { useSearchedTaskReveal, useSessionSourceMessage } from '../../../../apps/desktop/src/session/renderer/features/sessions/acp/use-session-source-message'
import { askTaskReveal, takeTaskReveal } from '../../../../apps/desktop/src/hooks/useSourceMessageReveal'
import { UI_EVENTS } from '../../../../apps/desktop/src/lib/uiEvents'
import { until } from '../../../support/awaitCondition'

/**
 * 全局搜索跳进一个没打开过的任务:view 先到,第一页历史后到。历史没到时取走请求,这次跳转就白白花掉了 ——
 * 什么都没载入,也没有游标可往上翻。判据用产品那一份 hook 和 store 的形状:「view 与历史都到了」是 hook 自己判的,
 * 把这个判断改回只看 view,这里必须红。
 */
const turn = (id: string, seq: number): TranscriptTurn => ({
  id: `turn-${seq}`, seq, initiator: 'user',
  items: [{ kind: 'message', id, role: 'user', text: id }],
} as unknown as TranscriptTurn)

function fixture(olderPages: TranscriptTurn[][] = []) {
  const state = { committedTurns: [] as readonly TranscriptTurn[], activeTurnSnapshot: null }
  const pages = [...olderPages]
  const history = observable({ loading: true })
  const store = {
    sessionId: 'task-a',
    get historyLoading() { return history.loading },
    chatState: { transcript: { state } },
    get canLoadOlderHistory() { return !history.loading && pages.length > 0 },
    loadOlderHistory: vi.fn(async () => pages.shift() ?? []),
  }
  const view = {
    scrollToItem: vi.fn(),
    loadOlder: (older: TranscriptTurn[]) => { state.committedTurns = [...older, ...state.committedTurns] },
  }
  const missing = vi.fn()
  let flash: string | null = null
  function Harness({ viewReady = true }: { viewReady?: boolean }) {
    const chatView = viewReady ? view as unknown as ChatView : null
    const viewRef = useRef(chatView)
    viewRef.current = chatView
    const source = useSessionSourceMessage(store, viewRef, missing)
    flash = source.flashMessageId
    useSearchedTaskReveal(store, chatView, source.reveal)
    return null
  }
  const firstPage = (turns: TranscriptTurn[]) => {
    state.committedTurns = turns
    act(() => runInAction(() => { history.loading = false }))
  }
  return { store, view, missing, Harness, firstPage, flashed: () => flash }
}

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  takeTaskReveal('task-a')
})

const reference = 'gugu-session://task-a?message=source'

describe('searched task reveal', () => {
  it('keeps the request until the first history page arrives, then lands on it', async () => {
    const task = fixture()
    askTaskReveal('task-a', reference)

    act(() => root.render(<task.Harness />))
    expect(task.view.scrollToItem).not.toHaveBeenCalled()
    expect(task.missing).not.toHaveBeenCalled()

    task.firstPage([turn('source', 1), turn('latest', 2)])

    expect(task.view.scrollToItem).toHaveBeenCalledWith('source', { align: 'center' })
    await until('the source row flashes', () => task.flashed() === 'source')
    expect(task.missing).not.toHaveBeenCalled()
  })

  it('pages back from the first page when the turn is older than it', async () => {
    const task = fixture([[turn('source', 1)]])
    askTaskReveal('task-a', reference)

    act(() => root.render(<task.Harness />))
    task.firstPage([turn('latest', 2)])

    await until('the source row flashes', () => task.flashed() === 'source')
    expect(task.store.loadOlderHistory).toHaveBeenCalledOnce()
    expect(task.view.scrollToItem).toHaveBeenLastCalledWith('source', { align: 'center' })
    expect(task.missing).not.toHaveBeenCalled()
  })

  it('leaves a request asked while history is loading for when it is in', async () => {
    const task = fixture()
    act(() => root.render(<task.Harness />))

    askTaskReveal('task-a', reference)
    act(() => { window.dispatchEvent(new CustomEvent(UI_EVENTS.chatAsked)) })
    expect(task.view.scrollToItem).not.toHaveBeenCalled()

    task.firstPage([turn('source', 1)])
    await until('the source row flashes', () => task.flashed() === 'source')
  })

  it('waits for the view when history is in first', async () => {
    const task = fixture()
    askTaskReveal('task-a', reference)
    act(() => root.render(<task.Harness viewReady={false} />))

    task.firstPage([turn('source', 1)])
    expect(task.view.scrollToItem).not.toHaveBeenCalled()

    act(() => root.render(<task.Harness />))
    await until('the source row flashes', () => task.flashed() === 'source')
  })
})
