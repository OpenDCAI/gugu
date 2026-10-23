// @vitest-environment jsdom
import { createElement, Fragment } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), dismiss: vi.fn() }), Toaster: () => createElement('div', { 'data-testid': 'toaster' }) }))

import { NoticeHost } from '../../../../apps/desktop/src/components/NoticeHost'
import { createReactHarness } from '../../../support/testHarness'

let harness: ReturnType<typeof createReactHarness>
const toasters = () => harness.container.querySelectorAll('[data-testid="toaster"]').length
const holder = () => document.documentElement.dataset.noticeHost?.split(':')[0]
const host = (key: string, embedded = false) => createElement(NoticeHost, { key, embedded })
const render = (...hosts: Array<ReturnType<typeof host>>) => harness.render(createElement(Fragment, null, ...hosts))

beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn((query: string): MediaQueryList => ({
    matches: false, media: query, onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: () => true,
  })))
  harness = createReactHarness()
})
afterEach(() => {
  harness.cleanup()
  vi.unstubAllGlobals()
})

// sonner 的状态全窗口一份:同一个文档里挂两个宿主,每条提示就会画两遍;一个都没有,提示就凭空消失。
describe('提示条的宿主:同一个文档里一次只有一个在画(#137)', () => {
  it('主 app 与会话页各挂一个:只画一份', async () => {
    await render(host('app'), host('session', true))
    expect(toasters()).toBe(1)
    expect(holder()).toBe('app')
  })

  it('会话页先挂上,主 app 的宿主后到:从它手里接过来,❌ 提示条留在一个看不见的宿主里', async () => {
    await render(host('session', true))
    expect(toasters()).toBe(1)
    expect(holder()).toBe('embedded')
    await render(host('session', true), host('app'))
    expect(toasters()).toBe(1)
    expect(holder()).toBe('app')
    // 它卸载后,会话页的立刻接上
    await render(host('session', true))
    expect(toasters()).toBe(1)
    expect(holder()).toBe('embedded')
  })

  it('画的那个卸载了,留着的接着画;全卸载了认领也清空,下一个能再认领', async () => {
    await render(host('a'), host('b'))
    expect(toasters()).toBe(1)
    await render(host('b'))
    expect(toasters()).toBe(1)
    await render()
    expect(toasters()).toBe(0)
    expect(document.documentElement.dataset.noticeHost).toBeUndefined()
    await render(host('c'))
    expect(toasters()).toBe(1)
  })

  it('会话页单独成文档(没有主 app)时由它自己画', async () => {
    await render(host('session', true))
    expect(toasters()).toBe(1)
  })
})
