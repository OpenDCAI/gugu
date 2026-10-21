// @vitest-environment jsdom
// #5610 §2.5 埋雷之一:根边界的外壳从前是个跑 useTranslation 的函数组件,它在边界**之上**,i18n 一坏
// 它自己抛、上面无人接 → 真白屏。现在正常路径不碰 i18n,文案在出错那一刻才取、取不到有最后一层。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNode, createReactHarness } from '../../../support/testHarness'
import { i18n } from '../../../../apps/desktop/src/i18n/runtime'
import { AppErrorBoundary } from '../../../../apps/desktop/src/components/AppErrorBoundary'

function Bomb(): never { throw new Error('root exploded') }

describe('AppErrorBoundary shell', () => {
  let consoleError: ReturnType<typeof vi.spyOn>
  let t: ReturnType<typeof vi.spyOn>
  let harness: ReturnType<typeof createReactHarness>
  beforeEach(() => {
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    t = vi.spyOn(i18n, 't')
    harness = createReactHarness()
  })
  afterEach(() => {
    harness.cleanup()
    t.mockRestore()
    consoleError.mockRestore()
  })

  it('does not touch i18n while rendering healthy children', async () => {
    await harness.render(createNode(AppErrorBoundary, null, createNode('div', { 'data-testid': 'healthy' })))
    expect(document.body.querySelector('[data-testid="healthy"]')).not.toBeNull()
    expect(t).not.toHaveBeenCalled()
  })

  it('renders the localized fallback when a child throws', async () => {
    await harness.render(createNode(AppErrorBoundary, null, createNode(Bomb)))
    expect(document.body.textContent).toContain('出错了')
    expect(document.body.textContent).toContain('重新加载')
  })

  it('still renders a fallback when i18n itself throws — the root boundary has nobody above it', async () => {
    t.mockImplementation(() => { throw new Error('i18n not initialised') })
    await harness.render(createNode(AppErrorBoundary, null, createNode(Bomb)))
    expect(document.body.textContent).toContain('Something went wrong')
    expect(document.body.querySelector('button')?.textContent).toBe('Reload')
  })
})
