// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentSharePopover } from '../../../../apps/desktop/src/components/sessionpage/AgentSharePopover'

// #6093 分享浮层收回成纯分享:两行的表(咕咕号 / 邀请链接),整行点击即复制;agent 名 / ID、会话 ID 归侧栏
// 身份卡(#6092),这里一行都不摆;没有改名入口(改名在会话页「重命名」弹窗,#6091);没号时邀请链接那一行不出现。
let container: HTMLDivElement
let root: Root
let writeText: ReturnType<typeof vi.fn>
let closed: number

function render(overrides: Partial<Parameters<typeof AgentSharePopover>[0]> = {}): void {
  act(() => {
    root.render(
      createElement(AgentSharePopover, {
        name: 'Codex 8',
        guguNumber: 123456,
        agentUserId: 'agent-id-1234567890',
        inviteUrl: 'https://example.test/invite',
        anchor: () => null,
        onOpenPoster: () => {},
        onMakePublic: async () => {},
        onClose: () => {
          closed += 1
        },
        ...overrides,
      }),
    )
  })
}
/** 浮层走 Base UI 的 Portal,画在 document.body 下而不是 container 里 —— 查询跟着搬家。 */
function rows(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-share-row]'))
}
function row(key: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-share-row="${key}"]`)
  if (!el) throw new Error(`没有 ${key} 这一行`)
  return el
}
const flush = async () => { await act(async () => { await Promise.resolve() }) }

beforeEach(() => {
  closed = 0
  writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('AgentSharePopover (#6093)', () => {
  it('有号:只有咕咕号与邀请链接两行,不摆 agent / 会话 ID;整行点击复制的就是显示的那个值', async () => {
    render()
    expect(rows().map((el) => el.dataset.shareRow)).toEqual(['guguNumber', 'inviteLink'])
    expect(document.body.textContent).not.toContain('agent-id-1234')
    const number = row('guguNumber')
    expect(number.tagName).toBe('BUTTON')
    expect(number.textContent).toContain('123456')

    act(() => { number.click() })
    await flush()
    expect(writeText).toHaveBeenCalledWith('123456')
    expect(number.dataset.copyState).toBe('copied')
    // 复制不等于关掉浮层。
    expect(closed).toBe(0)

    act(() => { row('inviteLink').click() })
    await flush()
    expect(writeText).toHaveBeenLastCalledWith('https://example.test/invite')
  })

  it('没号:咕咕号写「未分配」且不是按钮,邀请链接那一行不出现', () => {
    render({ guguNumber: null, inviteUrl: null })
    expect(rows().map((el) => el.dataset.shareRow)).toEqual(['guguNumber'])
    expect(row('guguNumber').tagName).not.toBe('BUTTON')
  })

  it('浮层里没有改名入口:没有输入框,双击名字也不会出现一个', () => {
    render()
    const name = document.querySelector('[data-testid="agent-share-name"]')
    expect(name).not.toBeNull()
    act(() => { name!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })) })
    expect(document.querySelector('input')).toBeNull()
  })

  it('复制失败就地说,不吞', async () => {
    writeText.mockRejectedValueOnce(new Error('Clipboard denied /Users/test/private sk-synthetic-secret\nstack detail'))
    render()
    act(() => { row('guguNumber').click() })
    await flush()
    expect(row('guguNumber').dataset.copyState).toBe('failed')
    expect(row('guguNumber').textContent).toContain('Clipboard denied [path] [redacted token]')
  })
})
