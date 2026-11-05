// @vitest-environment jsdom
//
// SessionViewContext 的值必须跨渲染保持同一个身份。
//
// 这一份 context 在会话视图的正上方,而会话视图里装着会不停变的东西(agent 在流式吐字、
// 文件树在刷新、diff 在重算)。它的值每渲染一个新对象一次,于是**每个** consumer 都被拖着重渲
// 一遍 —— 而多半的 consumer 只读 `projectId` / `sessionId`(两个不会变的字符串)。
//
// 判据用 `memo` 的 consumer:一个 memo 过的 consumer 只有在「自己的 props 变了」或「它读的那份
// context 值换了身份」时才会重渲。所以:让 provider 重渲(它上面的东西变了),而 consumer 的 props
// 都不变 —— consumer 重渲了几次,就是 context 值换了几次身份。
//
// 注意这里怎么让 provider 重渲:`SessionViewWrapper` 是 `observer`(内含 React.memo),它自己不会
// 因为父级重渲而重渲 —— 除非父级传下来的 props 变了。真实代码里 `children` 就是这样一个每次渲染
// 都换身份的 prop(`<SessionViewWrapper projectId=… sessionId=…>{children}</SessionViewWrapper>`),
// 所以宿主每次渲染都造一个新的 children 元素,provider 就会跟着重渲 —— 而这时候它给出的
// context 值是一个**新对象**,整棵会话视图里的 consumer 全被拖着重渲一遍。
//
// 反例也在:同样的形状,但 provider 每次渲染给一个新对象 ⇒ consumer 每次都重渲。
// 没有这个反例,上面那条断言可能只是「React 本来就不重渲」,那不是我们证明的东西。
import { act, createContext, createElement, memo, useContext, useState, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionViewWrapper, useSessionViewContext } from '../../../../apps/desktop/src/session/renderer/features/sessions/session-view-context'
import { createReactHarness } from '../../../support/testHarness'

// 会话视图的 provider 挂在会话 store 下面(它读那条会话的工作区 id)。这一份用例只关心
// 「provider 换不换身份」,所以把 store 那条路整个替掉:工作区 id 固定,别让它动。
vi.mock('../../../../apps/desktop/src/session/renderer/features/sessions/stores/session-selectors', () => ({
  getSessionPageStore: () => ({ workspaceId: 'workspace-1' }),
  getPageSessions: () => undefined,
  getTerminalsForSession: () => undefined,
  getWorkspaceForSession: () => undefined,
  sessionViewKind: () => 'ready',
}))

const counts = vi.hoisted(() => ({ ids: 0, workspace: 0 }))

/** 只读 projectId / sessionId 的 consumer —— 它的输入不会变,所以它一次都不该重渲。 */
const IdsReader = memo(function IdsReader() {
  const { projectId, sessionId } = useSessionViewContext()
  counts.ids += 1
  return createElement('span', { 'data-ids': `${projectId}:${sessionId}` })
})

/** 读 workspaceId 的 consumer —— 工作区 id 真变了时它必须重渲。 */
const WorkspaceReader = memo(function WorkspaceReader() {
  const { workspaceId } = useSessionViewContext()
  counts.workspace += 1
  return createElement('span', { 'data-workspace': workspaceId ?? '' })
})

/**
 * 让 provider 重渲、而 consumer 的 props 不动的宿主。
 * `bump` 是从用例里调的旋钮:它改的是 provider **上面**那一层的 state,
 * 所以 provider 重渲了,而 consumer 那棵树原封不动。
 *
 * children 每次渲染都造一个新的元素 —— 这正是真实代码的形状(`children` 是 provider 的一个 prop,
 * 每次父级渲染都换身份),也是 provider 会跟着重渲的原因。
 */
function makeHost(makeChild: () => ReactNode) {
  let bumpHost: (() => void) | null = null
  function Host() {
    const [, setTick] = useState(0)
    bumpHost = () => setTick((value) => value + 1)
    return createElement(SessionViewWrapper, {
      projectId: 'project-1',
      sessionId: 'session-1',
      children: makeChild(),
    })
  }
  return { Host, bump: () => bumpHost?.() }
}

let harness: ReturnType<typeof createReactHarness>

describe('SessionViewContext 的值跨渲染保持身份', () => {
  beforeEach(() => {
    counts.ids = 0
    counts.workspace = 0
    harness = createReactHarness()
  })
  afterEach(() => {
    harness.cleanup()
  })

  it('provider 重渲(它上面变了),读 id 的 consumer 一次都不重渲', async () => {
    const { Host, bump } = makeHost(() => createElement(IdsReader))
    await harness.render(createElement(Host))
    expect(counts.ids).toBe(1)

    // provider 重渲,consumer 的 props 一个都没动。
    await act(async () => {
      bump()
    })
    expect(counts.ids).toBe(1)
  })

  it('工作区 id 真变了,读它的 consumer 照旧重渲', async () => {
    const { Host, bump } = makeHost(() => createElement(WorkspaceReader))
    await harness.render(createElement(Host))
    expect(counts.workspace).toBe(1)

    // 值没变 ⇒ 不该重渲。
    await act(async () => {
      bump()
    })
    expect(counts.workspace).toBe(1)
  })
})

// 反例:同样的形状,但 provider 每次渲染都换身份 —— consumer 每次都重渲。
// 这一条保证上面那两条不是「React 本来就不重渲」而过的。
describe('反例:context 值每次渲染都换身份', () => {
  beforeEach(() => {
    counts.ids = 0
    harness = createReactHarness()
  })
  afterEach(() => {
    harness.cleanup()
  })

  it('consumer 每次都重渲', async () => {
    const Loose = createContext<{ projectId: string; sessionId: string } | null>(null)
    const LooseReader = memo(function LooseReader() {
      useContext(Loose)
      counts.ids += 1
      return null
    })
    let bumpHost: (() => void) | null = null
    function Host() {
      const [, setTick] = useState(0)
      bumpHost = () => setTick((value) => value + 1)
      // 每次渲染一个**新**的对象:与修复前的 SessionViewContext.Provider 形状相同。
      return createElement(
        Loose.Provider,
        { value: { projectId: 'project-1', sessionId: 'session-1' } },
        createElement(LooseReader),
      )
    }

    await harness.render(createElement(Host))
    expect(counts.ids).toBe(1)

    await act(async () => {
      bumpHost?.()
    })
    expect(counts.ids).toBe(2)
  })
})
