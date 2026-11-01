// @vitest-environment jsdom
//
// 2026-10-12 owner 手机实测「进去就颤两下」的第二下:思考行(嵌入的会话页转录)每挂一次都 `import()` 一遍
// session-chat-ui,打包后的动态 import 带预载包装,模块早在内存里也要几百 ms 才回调 ⇒ 那一行先 0 高、再撑开,
// 整条线程跟着跳(WebView 113 实测 +27 px)。模块加载过一次之后,挂上就在同一次提交里把视图建好。
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

const notice = vi.hoisted(() => vi.fn())
vi.mock('../../../apps/desktop/src/session/renderer/lib/hooks/use-toast', () => ({ toast: notice }))
vi.mock('../../../apps/desktop/src/session/renderer/localization/locale-store', () => ({ translateSessionMessage: () => 'Copy failed' }))
const commands: Array<{ onCopyError?: (error: unknown) => void }> = []
const created: HTMLElement[] = []
vi.mock('@gugu/session-chat-ui', () => ({
  createChatView: ({ parent, commands: actions }: { parent: HTMLElement; commands: typeof commands[number] }) => {
    commands.push(actions)
    const body = document.createElement('div')
    body.dataset.fakeView = 'true'
    parent.appendChild(body)
    created.push(parent)
    return { dispose: () => body.remove(), setModel: () => {}, setContentPadding: () => {}, setCommands: () => {}, setShown: () => {} }
  },
}))

const { ChatTranscript, loadChatUi } = await import('../../../apps/desktop/src/session/renderer/lib/chat/chat-transcript')

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<() => void> = []
afterEach(() => {
  while (roots.length) roots.pop()?.()
  created.length = 0
  commands.length = 0
  notice.mockClear()
})

function mountSync() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  // 同步 act:提交与 layout effect 都在这里跑完,❌ 冲微任务 —— 视图若要等一个 `.then` 才建,这一刻还不在。
  act(() => {
    root.render(<ChatTranscript context={{} as never} state={{} as never} />)
  })
  roots.push(() => {
    act(() => root.unmount())
    container.remove()
  })
  return container
}

describe('嵌入的会话页转录:模块加载过之后,挂上的同一次提交里就有视图', () => {
  it('模块已加载:挂上那一次同步提交里就有正文,❌ 等一个 then', async () => {
    await loadChatUi()
    const container = mountSync()
    expect(container.querySelector('[data-fake-view]'), 'the view waited for a promise callback').not.toBeNull()
    expect(created).toHaveLength(1)
  })
})

it('reports a transcript copy failure through the existing action notice', async () => {
  await loadChatUi()
  mountSync()
  commands[0]!.onCopyError!(new Error('Clipboard permission denied for /Users/alice/private.txt with sk-test_secret\nprivate stack'))
  expect(notice).toHaveBeenCalledExactlyOnceWith({ title: 'Copy failed', description: 'Clipboard permission denied for [path] with [redacted token]', tier: 'error' })
})
