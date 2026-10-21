// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'

/**
 * 守的是一件实测出来的事(2026-09-01):vite 热更新**会重新执行整个入口模块**,于是入口顶层的
 * `createRoot(container)` 在同一个容器上跑第二遍,React 只 `console.error` 一句
 * 「已经 createRoot 过」然后**照样建出第二棵树**。两棵互不知情的树争同一片 DOM,
 * 会话页终端第二次挂输入处理器就抛错,会话对象被 dispose,那个任务此后永久打不开。
 *
 * ⚠️ 判据的选法:**不能**只断言「渲染出来的内容是新的」—— 双 root 下第二棵树也会把新内容画上去,
 * 那条断言在坏实现上照样绿。这里断言的是「React 那句重复 createRoot 的 console.error 没出现」
 * 外加「容器下只有一棵树」,两条都能在旧写法上判假(见本文件末尾的反例)。
 */
const DUPLICATE_ROOT_WARNING = 'has already been passed to createRoot'

function makeContainer(id: string): HTMLElement {
  const el = document.createElement('div')
  el.id = id
  document.body.appendChild(el)
  return el
}

/** 每个用例拿一份全新的模块实例 —— 模块作用域里那张 root 表必须不跨用例串味。 */
async function freshModule() {
  vi.resetModules()
  return await import('@/lib/renderer-entry-root')
}

describe('渲染入口的 root 归属', () => {
  // 建出来的 root 必须逐个卸载。只清 document.body 不够:root 还挂着,React 的调度回调排在
  // setImmediate 上,等本文件跑完、jsdom 环境拆掉之后才执行 —— 那时 window 已经没了,
  // 抛 ReferenceError: window is not defined。vitest 把它记成 unhandled error:
  // **测试计数全绿,退出码却是 1**,于是这道门以后再也读不出真绿(实测 dev 上恒 4 条)。
  const mounted: Root[] = []
  const track = (root: Root): Root => { mounted.push(root); return root }

  beforeEach(() => {
    document.body.innerHTML = ''
  })

  afterEach(() => {
    for (const root of mounted.splice(0)) act(() => { root.unmount() })
  })

  it('同一容器渲染两次:复用同一个 root,不建第二棵树', async () => {
    const { renderEntryRoot, hasEntryRoot } = await freshModule()
    const container = makeContainer('root')
    const errors: unknown[][] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      errors.push(args)
    })

    expect(hasEntryRoot(container)).toBe(false)
    const first = track(renderEntryRoot('desktop', container, createElement('span', null, 'A')))
    expect(hasEntryRoot(container)).toBe(true)
    const second = track(renderEntryRoot('desktop', container, createElement('span', null, 'B')))

    spy.mockRestore()

    // 复用:同一个 root 对象。旧写法(每次 createRoot)这里是两个不同对象。
    expect(second).toBe(first)
    // React 没有抱怨过重复 createRoot。旧写法下这句必现。
    const complained = errors.some((args) =>
      args.some((a) => typeof a === 'string' && a.includes(DUPLICATE_ROOT_WARNING))
    )
    expect(complained, `React 抱怨了重复 createRoot: ${JSON.stringify(errors)}`).toBe(false)
  })

  it('两个不同入口指向同一容器:响亮失败,而不是悄悄顶掉前一棵树', async () => {
    const { renderEntryRoot } = await freshModule()
    const container = makeContainer('root')
    track(renderEntryRoot('desktop', container, createElement('span', null, 'A')))

    expect(() =>
      renderEntryRoot('session-embedded', container, createElement('span', null, 'B'))
    ).toThrow(/already owned by entry 'desktop'/)
  })

  it('不同容器各自建 root,互不干扰', async () => {
    const { renderEntryRoot, hasEntryRoot } = await freshModule()
    const a = makeContainer('root')
    const b = makeContainer('mount')

    const rootA = track(renderEntryRoot('desktop', a, createElement('span', null, 'A')))
    expect(hasEntryRoot(b)).toBe(false)
    const rootB = track(renderEntryRoot('session-embedded', b, createElement('span', null, 'B')))

    expect(rootB).not.toBe(rootA)
    expect(hasEntryRoot(a)).toBe(true)
    expect(hasEntryRoot(b)).toBe(true)
  })
})
