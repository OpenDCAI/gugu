import { createChatContext } from '@session-chat/chat-context'
import { createChatView } from '@session-chat/chat-view'
import { DEFAULT_THEME } from '@session-chat/core/theme'
import type { ChatLayoutPreset } from '@session-chat/core/layout/preset'
import type { TranscriptTurn } from '@session-chat/model'
import { createChatState } from '@session-chat/state/chat-state'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { until } from '../../../../tests/support/awaitCondition'

/**
 * 新建会话带着第一条消息(behavior session-page「打开速度」):那条消息发出那一刻就在屏上,下面就是
 * 这一轮在跑的样子 —— 与之后每条消息发出时相同。会话还在建立这件事对用户不存在:❌ 骨架屏(#7298 撤回),
 * ❌「正在打开引擎会话」一类的状态行。没能跑起来时那句话留着、不再显示在跑,要人做的事(登录)在它下面。
 *
 * 宿主那一侧(store 何时挂乐观行、何时留屏)见 acp-chat-store.first-prompt.test.ts;这里钉的是画出来的样子。
 */
const teardown: Array<() => void> = []

afterEach(() => {
  while (teardown.length) teardown.pop()?.()
})

function mount(preset: ChatLayoutPreset, opts: { pinUserMessages?: boolean } = {}) {
  const context = createChatContext({ theme: DEFAULT_THEME })
  context.setLayout({ preset, userGutter: 96 })
  const state = createChatState(context)
  const host = document.createElement('div')
  host.style.cssText = 'position:fixed;inset:0;width:640px;height:600px'
  document.body.append(host)
  const view = createChatView({ context, state, parent: host, ...opts })
  teardown.push(() => {
    view.dispose()
    state.dispose()
    context.dispose()
    host.remove()
  })
  return { state, host }
}

const FIRST = 'Look at this project.'
const header = (host: HTMLElement) => host.querySelector<HTMLElement>('[data-slot="turn-process"]')

describe('session start with a first message', () => {
  it.each(['single', 'double'] as ChatLayoutPreset[])(
    'shows the first message as already running while the session is set up ($0 layout)',
    async (preset) => {
      const { state, host } = mount(preset)
      state.session.setPendingPrompt({ id: 'first-prompt:s1', text: FIRST })

      await until('the first message and its running header are on screen', () =>
        (host.textContent?.includes(FIRST) ?? false) && header(host)?.getAttribute('data-live') === 'true'
      )
      expect(host.querySelectorAll('[data-user-card]')).toHaveLength(1)
      // 在跑,但不报秒数、不报启动步骤:还没有可折的过程,头只占位(行尾那个 › 是折叠箭头)。
      expect(header(host)?.textContent).toContain('Thinking…')
      expect(header(host)?.textContent).not.toMatch(/\d|Worked for/)
      expect(host.querySelector('[data-slot="session-condition"]')).toBeNull()
      expect(host.querySelector('[data-slot="session-start-skeleton"]')).toBeNull()

      // 会话建立、首轮开出:真的那一轮接过它,那句话只出现一次。
      const turn: TranscriptTurn = {
        id: 'live',
        seq: 0,
        initiator: 'user',
        startedAt: Date.now() - 2000,
        items: [{ kind: 'message', id: 'prompt', seq: 0, role: 'user', text: FIRST }]
      }
      state.transcript.activeTurn.set(turn)
      state.session.setPendingPrompt(null)
      await until('the real turn takes over', () => header(host)?.getAttribute('data-turn-id') ?? '', (id) => id === 'live')
      // 真的一轮开出来了,过程还没有:头照旧占位,不跳成秒数(owner 10-23)
      expect(header(host)?.textContent).toContain('Thinking…')
      expect(host.querySelectorAll('[data-user-card]')).toHaveLength(1)
    }
  )

  // 产品里那条会话页开着贴顶(最后一句贴到顶上、下面留出位置):乐观行与真的那一轮必须摆在同一个位置,
  // 否则会话一建立好,刚说的那句话就跳一下(真机实测:上移 20px —— 真的那一轮多出日期分隔、又贴了顶)。
  it.each(['single', 'double'] as ChatLayoutPreset[])(
    'the first message does not move when the real turn takes over ($0 layout)',
    async (preset) => {
      const { state, host } = mount(preset, { pinUserMessages: true })
      const sentAt = Date.now()
      state.session.setPendingPrompt({ id: 'first-prompt:s1', text: FIRST, sentAt })
      await until('the optimistic first message settles', () =>
        header(host)?.getAttribute('data-live') === 'true' && Boolean(host.querySelector('[data-slot="day-separator"]'))
      )
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      // 只有一张:贴顶的就是正文里那一行自己(sticky),它得不动。
      const cards = () => [...host.querySelectorAll<HTMLElement>('[data-user-card]')].map((e) => ({ rect: e.getBoundingClientRect() }))
      const before = cards()
      expect(before).toHaveLength(1)
      expect(header(host)?.textContent).not.toMatch(/\d/)

      state.transcript.activeTurn.set({
        id: 'live',
        seq: 0,
        initiator: 'user',
        startedAt: sentAt + 300,
        items: [{ kind: 'message', id: 'prompt', seq: 0, role: 'user', text: FIRST }]
      })
      state.session.setPendingPrompt(null)
      await until('the real turn takes over', () => header(host)?.getAttribute('data-turn-id') ?? '', (id) => id === 'live')
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      const after = cards()
      expect(after).toHaveLength(1)
      after.forEach((c, i) => {
        expect(Math.abs(c.rect.top - before[i]!.rect.top)).toBeLessThanOrEqual(1)
        expect(Math.abs(c.rect.left - before[i]!.rect.left)).toBeLessThanOrEqual(1)
      })
    }
  )

  it('a required sign-in shows under the held first message, which no longer runs', async () => {
    const { state, host } = mount('double')
    // store 在启动没成时把那句话留在已提交那一档(`_holdStartupPrompt`)。
    state.transcript.history.seed([
      {
        id: 'first-prompt:s1:held',
        seq: 0,
        initiator: 'user',
        items: [{ kind: 'message', id: 'first-prompt:s1', seq: 0, role: 'user', text: FIRST }]
      }
    ])
    const signIn = vi.fn()
    state.session.setCondition({
      code: 'auth-required',
      detail: 'sign-in-missing',
      label: 'Sign in to Claude to continue',
      actions: [{ label: 'Sign in', run: signIn }]
    })
    await until('sign-in action mounts', () =>
      Boolean(host.querySelector('button[data-slot="session-condition-action"]'))
    )
    expect(host.querySelectorAll('[data-user-card]')).toHaveLength(1)
    expect(host.textContent).toContain(FIRST)
    expect(host.querySelector('[data-slot="turn-process"][data-live="true"]')).toBeNull()
    host.querySelector<HTMLButtonElement>('button[data-slot="session-condition-action"]')!.click()
    expect(signIn).toHaveBeenCalledOnce()
  })
})
