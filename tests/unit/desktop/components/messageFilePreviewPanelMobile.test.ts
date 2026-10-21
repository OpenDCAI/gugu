// @vitest-environment jsdom
// 2026-09-29 手机实测:点视频 / 文件卡打开的整页预览,出口是右上 32×32 的 ✕ —— 移动端规范是左上返回、触控 ≥44。
import { act, createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MessageFilePreviewPanel } from '../../../../apps/desktop/src/components/chat/MessageFilePreviewPanel'
import { createReactHarness } from '../../../support/testHarness'

const file = { kind: 'file' as const, fileName: 'clip-bxc.webm', mimeType: 'video/webm', sizeBytes: 331082, url: 'https://files.test/clip-bxc.webm' }

describe('手机文件预览的出口', () => {
  let harness: ReturnType<typeof createReactHarness> | null = null
  afterEach(() => { harness?.cleanup(); harness = null })
  const render = async (mobile: boolean, onClose = vi.fn(), onDownload = vi.fn(), onOpenExternal = vi.fn()) => {
    harness = createReactHarness()
    await harness.render(createElement(MessageFilePreviewPanel, { file, kind: 'video', content: null, loading: false, onDownload, onOpenExternal, onClose, mobile }))
    return { onClose, onDownload, onOpenExternal, container: harness.container }
  }

  it('手机:页头左边只有一个按钮,就是出口,点它关预览', async () => {
    const { onClose, container } = await render(true)
    const header = container.querySelector('[data-slot="pane-header"]')
    expect(header).not.toBeNull()
    const leading = Array.from(header!.querySelectorAll('button')).filter((button) => !button.closest('.gg-pane-actions'))
    expect(leading).toHaveLength(1)
    expect(header!.firstElementChild?.contains(leading[0])).toBe(true)
    await act(async () => { leading[0].click() })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  // owner 10-15:「手机端过于简陋,尤其是下载按钮」—— 原来页头下面单独一排大按钮 + 一行 MIME 原文。
  it('手机:下载与外部打开是页头右上的图标,文件名下面一行「扩展名 · 大小」,❌ 单独一排按钮', async () => {
    const { onDownload, onOpenExternal, container } = await render(true)
    const actions = container.querySelectorAll<HTMLButtonElement>('[data-slot="pane-header"] .gg-pane-actions button')
    expect(actions).toHaveLength(2)
    expect(container.querySelector('[data-testid="message-file-preview-meta"]')?.textContent).toBe('WEBM · 323.3 KB')
    // 页头之外没有别的按钮(那一排大按钮没了)
    const outside = Array.from(container.querySelectorAll('button')).filter((button) => !button.closest('[data-slot="pane-header"]'))
    expect(outside).toHaveLength(0)
    await act(async () => { actions[0].click(); actions[1].click() })
    expect(onOpenExternal).toHaveBeenCalledTimes(1)
    expect(onDownload).toHaveBeenCalledTimes(1)
  })

  it('手机附件卡从那台电脑取的时候:那行字是读到哪了,下面一条进度', async () => {
    harness = createReactHarness()
    await harness.render(createElement(MessageFilePreviewPanel, {
      file: { ...file, sizeBytes: 0 }, kind: 'unsupported', content: null, loading: true,
      loadingLabel: '正在从那台电脑取 2.0 MB / 6.0 MB', loadingFraction: 1 / 3, onClose: vi.fn(), mobile: true,
    }))
    const status = harness.container.querySelector('[data-testid="message-file-preview-loading"]')
    expect(status?.textContent).toBe('正在从那台电脑取 2.0 MB / 6.0 MB')
    const bar = status?.querySelector('progress')
    expect(bar?.value).toBeCloseTo(1 / 3)
    expect(bar?.max).toBe(1)
  })

  it('桌面右栏:页头照旧是标题 + 右上关闭', async () => {
    const { onClose, container } = await render(false)
    expect(container.querySelector('[data-slot="pane-header"]')).toBeNull()
    const close = container.querySelector('header')!.lastElementChild as HTMLButtonElement
    await act(async () => { close.click() })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
