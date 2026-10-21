// @vitest-environment jsdom
import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useBoundChatView } from '../../../../apps/desktop/src/session/renderer/features/sessions/acp/use-bound-chat-view'

/**
 * #4452 —— 晚到的 transcript view 必须仍然被绑上。
 *
 * `ChatTranscript` 在 `import('@gugu/session-chat-ui').then(...)` 里才 `createChatView`，
 * 所以 `onReady` **必然**晚于会话面板自己的 effect。句柄只放 ref、绑定 effect 只按 `[store]`
 * 跑一次时，交给 store 的是当时还是 null 的 ref，而且再也不会重跑 ⇒ `store._view` 终身为 null，
 * 于是 `this._view?.setScrollMode(...)` 在 `?.` 上整条短路：不报错、不生效、类型也不红。
 *
 * 实测后果（#4452 B 面，真机）：视口滚到顶端后发消息，画面一动不动 —— 既没滚到末尾，
 * 也没把新消息钉到视口顶端；两种设计下画面都该动。
 *
 * ⚠️ **它导入产品那一份 `useBoundChatView`，不抄写同形的接线。**
 * 这条判据的第一版抄了一份放进自己文件里，于是把产品那段整个回退它照样 2/2 通过 ——
 * 当时的「变异对照」改的是**抄本**：证明了断言逻辑会红，却没证明它守着产品。
 * 判据的主语错了，绿灯就是空头支票。
 * 现在的变异对照是：把产品那份接线回退到修复前，这里必须红。
 */

/**
 * 与真面板同形的宿主：view 在**一个 microtask 之后**才造出来（真产品是动态 import 的 then），
 * 所以它必然晚于宿主的第一次 effect。
 */
function Harness({
  store,
  view,
  gone,
}: {
  store: { bindView: (view: unknown) => void }
  view: unknown
  gone?: boolean
}) {
  const { onReady, onGone } = useBoundChatView(store as never)
  useEffect(() => {
    let disposed = false
    void Promise.resolve().then(() => {
      if (!disposed) onReady(view as never)
    })
    return () => {
      disposed = true
    }
  }, [onReady, view])
  useEffect(() => {
    if (gone) onGone()
  }, [gone, onGone])
  return null
}

let root: Root | null = null
let container: HTMLDivElement | null = null

beforeEach(() => {
  const actEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = null
  container = null
})

describe('#4452 晚到的 transcript view', () => {
  it('阳性对照：宿主第一次结算时句柄确实还不在', () => {
    const bindView = vi.fn()
    const view = { id: 'late-view' }
    act(() => {
      root!.render(<Harness store={{ bindView }} view={view} />)
    })
    // 第一次 effect 已经跑过，而 view 还在 microtask 里 —— 这一刻绑进去的必然是 null。
    expect(bindView).toHaveBeenCalledWith(null)
    expect(bindView).not.toHaveBeenCalledWith(view)
  })

  it('句柄到达后，store 拿到的是句柄本身而不是 null', async () => {
    const bindView = vi.fn()
    const view = { id: 'late-view' }
    await act(async () => {
      root!.render(<Harness store={{ bindView }} view={view} />)
      await Promise.resolve()
    })
    expect(bindView).toHaveBeenCalledWith(view)
    // 最后一次调用必须是「绑上」，❌ 不是收尾时的解绑 —— 顺序错了同样等于没绑。
    expect(bindView.mock.calls[bindView.mock.calls.length - 1]?.[0]).toBe(view)
  })

  it('transcript 没了之后，绑上去的必须是 null 而不是那个已 dispose 的句柄', async () => {
    const bindView = vi.fn()
    const view = { id: 'late-view' }
    await act(async () => {
      root!.render(<Harness store={{ bindView }} view={view} />)
      await Promise.resolve()
    })
    await act(async () => {
      root!.render(<Harness store={{ bindView }} view={view} gone />)
      await Promise.resolve()
    })
    // 留着死句柄比留 null 更糟：`?.` 不再短路，调用会落到一个已释放的 root 上。
    expect(bindView.mock.calls[bindView.mock.calls.length - 1]?.[0]).toBeNull()
  })
})
