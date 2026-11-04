// @vitest-environment jsdom
//
// PaneContext 的值必须跨渲染保持同一个身份。
//
// 这一份 context 在 pane 的正上方,而 pane 里装着会不停变的东西(会话在流式吐字、页签在开合)。
// 它的值每渲染一个新对象一次,于是**每个** consumer 都被拖着重渲一遍 —— 而多半的 consumer
// 只读 `paneId`(一个不会变的字符串)。
//
// 判据用 `memo` 的 consumer:一个 memo 过的 consumer 只有在「自己的 props 变了」或「它读的那份
// context 值换了身份」时才会重渲。所以:让 provider 重渲(它上面的东西变了),而 consumer 的 props
// 与 children 都不变 —— consumer 重渲了几次,就是 context 值换了几次身份。
//
// 反例也在:同样的形状,但 provider 每次渲染给一个新对象 ⇒ consumer 每次都重渲。
// 没有这个反例,上面那条断言可能只是「React 本来就不重渲」,那不是我们证明的东西。
import { act, createContext, createElement, memo, useContext, useState, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PageShownContext } from '../../../../apps/desktop/src/session/renderer/app/recent-session-pages'
import { PaneProvider, usePaneContext } from '../../../../apps/desktop/src/session/renderer/features/tabs/pane-context'
import type { Pane } from '../../../../apps/desktop/src/session/renderer/features/tabs/pane-layout-store'
import { createReactHarness } from '../../../support/testHarness'

vi.mock('../../../../apps/desktop/src/session/renderer/features/settings/use-app-settings-key', () => ({
  useAppSettingsKey: () => ({ value: undefined }),
}))

const counts = vi.hoisted(() => ({ paneId: 0, focused: 0 }))

function stubPane(paneId: string) {
  const pane = {
    setNextTabActive: vi.fn(),
    setPreviousTabActive: vi.fn(),
    setTabActiveIndex: vi.fn(),
    closeActiveTab: vi.fn(),
  }
  return { group: { paneId, pane } as unknown as Pane, pane }
}

/** 只读 paneId 的 consumer —— 它的输入不会变,所以它一次都不该重渲。 */
const PaneIdReader = memo(function PaneIdReader() {
  const { paneId } = usePaneContext()
  counts.paneId += 1
  return createElement('span', { 'data-pane-id': paneId })
})

/** 读 isFocusedPane 的 consumer —— 焦点真变了时它必须重渲。 */
const FocusedReader = memo(function FocusedReader() {
  const { isFocusedPane } = usePaneContext()
  counts.focused += 1
  return createElement('span', { 'data-focused': String(isFocusedPane) })
})

/**
 * 让 provider 重渲、而 consumer 的 props 与 children 都不动的宿主。
 * `bump` 是从用例里调的旋钮:它改的是 provider **上面**那一层的 state,
 * 所以 provider 重渲了,而 consumer 那棵树原封不动。
 */
function makeHost(group: Pane) {
  let bumpHost: (() => void) | null = null
  function Host({ isFocusedPane, children }: { isFocusedPane: boolean; children?: ReactNode }) {
    const [, setTick] = useState(0)
    bumpHost = () => setTick((value) => value + 1)
    return createElement(
      PageShownContext.Provider,
      { value: true },
      createElement(PaneProvider, { group, isFocusedPane }, children),
    )
  }
  return { Host, bump: () => bumpHost?.() }
}

let harness: ReturnType<typeof createReactHarness>

describe('PaneContext 的值跨渲染保持身份', () => {
  beforeEach(() => {
    counts.paneId = 0
    counts.focused = 0
    harness = createReactHarness()
  })
  afterEach(() => {
    harness.cleanup()
  })

  it('provider 重渲(它上面变了),读 paneId 的 consumer 一次都不重渲', async () => {
    const { group } = stubPane('pane-1')
    const { Host, bump } = makeHost(group)
    await harness.render(createElement(Host, { isFocusedPane: true }, createElement(PaneIdReader)))
    expect(counts.paneId).toBe(1)

    // provider 重渲,consumer 的 props / children 一个都没动。
    await act(async () => {
      bump()
    })
    expect(counts.paneId).toBe(1)
  })

  it('焦点真的变了,读 isFocusedPane 的 consumer 照旧重渲', async () => {
    const { group } = stubPane('pane-1')
    const { Host, bump } = makeHost(group)
    const render = async (isFocusedPane: boolean) =>
      harness.render(createElement(Host, { isFocusedPane }, createElement(FocusedReader)))

    await render(true)
    expect(counts.focused).toBe(1)

    // 焦点没变 ⇒ 不该重渲。
    await act(async () => {
      bump()
    })
    expect(counts.focused).toBe(1)

    // 焦点变了 ⇒ 必须重渲(memo 没有把真变化也吞掉)。
    await render(false)
    expect(counts.focused).toBe(2)
  })
})

// 反例:同样的形状,但 provider 每次渲染给一个新对象 —— consumer 每次都重渲。
// 这一条保证上面那两条不是「React 本来就不重渲」而过的。
describe('反例:context 值每次渲染都换身份', () => {
  beforeEach(() => {
    counts.paneId = 0
    harness = createReactHarness()
  })
  afterEach(() => {
    harness.cleanup()
  })

  it('consumer 每次都重渲', async () => {
    const Loose = createContext<{ paneId: string } | null>(null)
    const LooseReader = memo(function LooseReader() {
      useContext(Loose)
      counts.paneId += 1
      return null
    })
    let bumpHost: (() => void) | null = null
    function Host({ children }: { children?: ReactNode }) {
      const [, setTick] = useState(0)
      bumpHost = () => setTick((value) => value + 1)
      // 每次渲染一个**新**的对象:与修复前的 PaneProvider 形状相同。
      return createElement(Loose.Provider, { value: { paneId: 'pane-1' } }, children)
    }

    await harness.render(createElement(Host, {}, createElement(LooseReader)))
    expect(counts.paneId).toBe(1)

    await act(async () => {
      bumpHost?.()
    })
    expect(counts.paneId).toBe(2)
  })
})
