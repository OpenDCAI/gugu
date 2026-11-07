import { createChatContext } from '@session-chat/chat-context'
import { createChatView } from '@session-chat/chat-view'
import { DEFAULT_THEME } from '@session-chat/core/theme'
import type { ChatLayoutPreset } from '@session-chat/core/layout/preset'
import type { TranscriptTurn } from '@session-chat/model'
import { createChatState } from '@session-chat/state/chat-state'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
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

function mount(preset: ChatLayoutPreset, { agentConversation, ...opts }: { pinUserMessages?: boolean; agentConversation?: boolean } = {}) {
  const context = createChatContext({ locale: () => 'en-US', theme: DEFAULT_THEME })
  context.setLayout({ preset, userGutter: 96, ...(agentConversation ? { agentConversation } : {}) })
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
  return { state, host, view }
}

const FIRST = 'Look at this project.'
const header = (host: HTMLElement) => host.querySelector<HTMLElement>('[data-slot="turn-process"]')

describe('ordinary sending stays in the transcript', () => {
  it('keeps the last bubble stationary when a long conversation enters host startup', async () => {
    const { state, host, view } = mount('double', { agentConversation: true })
    state.transcript.history.seed(Array.from({ length: 12 }, (_, seq) => ({
      id: `old-${seq}`, seq, initiator: 'user', startedAt: Date.now() - 30000 + seq,
      items: [{ kind: 'message', id: `old-${seq}-user`, seq: 0, role: 'user', text: `Previous input ${seq}` },
        { kind: 'message', id: `old-${seq}-reply`, seq: 1, role: 'assistant', text: `Previous reply ${seq}` }],
    } as TranscriptTurn)))
    const pending = { id: 'long-send', text: FIRST, sentAt: Date.now(), held: true, delivery: { state: 'sending' as const } }
    state.session.setPendingPrompt(pending)
    view.setScrollMode({ kind: 'tail' })
    await until('the last bubble is on screen', () => !!host.querySelector('[data-user-card="long-send"]'))
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const before = host.querySelector('[data-user-card="long-send"]')!.getBoundingClientRect().top
    state.session.setPendingPrompt({ ...pending, starting: 'starting', delivery: { state: 'accepted' } })
    await until('the host startup line mounts', () => (host.textContent ?? '').includes('Starting'))
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    expect(host.querySelectorAll('[data-user-card="long-send"]')).toHaveLength(1)
    expect(Math.abs(host.querySelector('[data-user-card="long-send"]')!.getBoundingClientRect().top - before)).toBeLessThanOrEqual(1)
  })

  it.each(['single', 'double'] as ChatLayoutPreset[])('keeps one bubble through acknowledgement, history and native echo (%s)', async preset => {
    const { state, host } = mount(preset, { agentConversation: true, pinUserMessages: true })
    const sentAt = Date.now()
    const pending = { id: 'send', text: FIRST, sentAt, held: true, delivery: { state: 'sending' as const } }
    state.session.setPendingPrompt(pending)
    await until('the pending input is drawn', () => host.querySelectorAll('[data-user-card]').length === 1 && !!host.querySelector('[data-send-state="sending"]'))
    const top = host.querySelector('[data-user-card]')!.getBoundingClientRect().top
    state.transcript.history.seed([])
    state.session.setPendingPrompt({ ...pending, delivery: { state: 'accepted' } })
    await until('accepted input stays without its spinner', () => host.querySelectorAll('[data-user-card]').length === 1 && !host.querySelector('[data-send-state="sending"]'))
    expect(Math.abs(host.querySelector('[data-user-card]')!.getBoundingClientRect().top - top)).toBeLessThanOrEqual(1)
    state.transcript.activeTurn.set({ id: 'native', seq: 1, initiator: 'user', startedAt: sentAt, items: [] })
    await until('an early native turn does not hide the input', () => !!host.querySelector('[data-user-card="send"]'))
    state.transcript.activeTurn.set({ id: 'native', seq: 1, initiator: 'user', startedAt: sentAt,
      items: [{ kind: 'message', id: 'echo', seq: 0, role: 'user', text: FIRST }] })
    await until('its native echo replaces the pending projection once', () => !!host.querySelector('[data-user-card="echo"]') && host.querySelectorAll('[data-user-card]').length === 1)
    expect(Math.abs(host.querySelector('[data-user-card]')!.getBoundingClientRect().top - top)).toBeLessThanOrEqual(1)
  })

  it('keeps sender-owned input waiting without a retry action or a running agent', async () => {
    const { state, host, view } = mount('double', { agentConversation: true })
    const retry = vi.fn()
    view.setCommands({ onRetrySend: retry })
    state.session.setPendingPrompt({ id: 'owned', text: FIRST, held: true,
      delivery: { state: 'waiting', reason: 'Send interrupted', error: 'SSH transport closed', retryable: false } })
    await until('automatic custody status is visible', () => !!host.querySelector('[data-send-state="waiting"]'))
    expect(host.textContent).toContain('Waiting to send · Send interrupted')
    expect(host.querySelector('[data-send-state="waiting"]')?.getAttribute('title')).toBe('SSH transport closed')
    expect(host.querySelector('[data-send-state="waiting"] button')).toBeNull()
    expect(host.querySelector('[data-live="true"]')).toBeNull()
    expect(host.querySelectorAll('[data-user-card]')).toHaveLength(1)
    expect(retry).not.toHaveBeenCalled()
  })

  it('keeps the failed input and a working retry action in place', async () => {
    const { state, host, view } = mount('double', { agentConversation: true })
    const retry = vi.fn()
    view.setCommands({ onRetrySend: retry })
    state.session.setPendingPrompt({ id: 'send', text: FIRST, held: true,
      delivery: { state: 'failed', error: 'connection refused' } })
    await until('failed input exposes retry', () => !!host.querySelector('[data-send-state="failed"] button'))
    expect(host.querySelectorAll('[data-user-card]')).toHaveLength(1)
    expect(host.querySelector('[data-send-state="failed"]')?.getAttribute('title')).toBe('connection refused')
    expect(host.querySelector('[data-live="true"]')).toBeNull()
    host.querySelector<HTMLButtonElement>('[data-send-state="failed"] button')!.click()
    expect(retry).toHaveBeenCalledWith('send')
  })
})

describe('session start with a first message', () => {
  it.each(['committed', 'active'] as const)('removes stopped actions when a newer %s response takes over', async kind => {
    const { state, host, view } = mount('double', { agentConversation: true })
    view.setCommands({ onContinueTurn: () => {}, onDiscardTurn: () => {} })
    const stopped = {
      id: 'stopped', seq: 0, initiator: 'user', startedAt: 1, endedAt: 2,
      items: [
        { kind: 'message', id: 'old-user', seq: 0, role: 'user', text: 'First request' },
        { kind: 'message', id: 'old-agent', seq: 1, role: 'assistant', text: 'Partial answer' },
      ],
      outcome: { kind: 'cancelled', reason: 'cancelled' },
    } as TranscriptTurn
    state.transcript.history.seed([stopped])
    await until('latest stopped response has both actions', () => Boolean(
      host.querySelector('[data-slot="turn-outcome-continue"]') && host.querySelector('[data-slot="turn-outcome-discard"]')
    ))
    const next = {
      id: 'next', seq: 1, initiator: 'user', startedAt: 3,
      items: [{ kind: 'message', id: 'next-user', seq: 0, role: 'user', text: 'Continue the request' }],
      ...(kind === 'committed' ? { endedAt: 4, outcome: { kind: 'done' } } : {}),
    } as TranscriptTurn
    // Append keeps the old committed outcome cached; an active snapshot does not rebuild it either.
    if (kind === 'committed') state.transcript.history.append([next])
    else state.transcript.activeTurn.set(next)
    await until('new response appears', () => host.textContent?.includes('Continue the request') === true)
    expect(host.querySelector('[data-slot="turn-outcome-continue"]')).toBeNull()
    expect(host.querySelector('[data-slot="turn-outcome-discard"]')).toBeNull()
    expect(host.textContent).toContain('Stopped')
  })

  it.each(['single', 'double'] as ChatLayoutPreset[])(
    'shows the first message as already running while the session is set up ($0 layout)',
    async (preset) => {
      const { state, host } = mount(preset)
      state.session.setPendingPrompt({ id: 'first-prompt:s1', text: FIRST })

      await until('the first message and its running header are on screen', () =>
        (host.textContent?.includes(FIRST) ?? false) && header(host)?.getAttribute('data-live') === 'true'
      )
      expect(host.querySelectorAll('[data-user-card]')).toHaveLength(1)
      // 在跑,但不报秒数、不报启动步骤:还没有可折的过程,头只占位。
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

  it('discard reaches its command before the click delegate toggles the row away; a turn can opt out', async () => {
    const { state, host, view } = mount('double', { agentConversation: true })
    const discarded: string[] = []
    view.setCommands({ onDiscardTurn: ({ turnId }) => discarded.push(turnId), canDiscardTurn: (turnId) => turnId !== 'delivered' })
    const stopped = (id: string, seq: number) => ({ id, seq, initiator: 'user' as const, startedAt: Date.now(), endedAt: Date.now(),
      items: [{ kind: 'message' as const, id: `${id}-m`, seq: 0, role: 'user' as const, text: FIRST }],
      outcome: { kind: 'cancelled' as const, reason: 'cancelled' as const } })
    state.transcript.history.seed([stopped('delivered', 0)] as unknown as TranscriptTurn[])
    await until('its stopped line', () => Boolean(host.querySelector('[data-slot="turn-outcome-continue"], [data-slot="turn-outcome-badge"]')))
    expect(host.querySelector('[data-slot="turn-outcome-discard"]'), 'a delivery offers no discard').toBeNull()

    state.transcript.history.seed([stopped('mine', 0)] as unknown as TranscriptTurn[])
    await until('its discard', () => Boolean(host.querySelector('[data-slot="turn-outcome-discard"]')))
    host.querySelector<HTMLButtonElement>('[data-slot="turn-outcome-discard"]')!.click()
    expect(discarded).toEqual(['mine'])
  })

  it('a queued first message says Starting, stays through a history seed, and keeps its clock', async () => {
    const { state, host } = mount('double', { agentConversation: true })
    const sentAt = Date.now() - 3000
    state.session.setPendingPrompt({ id: 'row', text: FIRST, sentAt, starting: 'starting', held: true })
    await until('the state line says Starting with seconds', () => /Starting · [3-9]s/.test(host.textContent ?? ''))

    state.transcript.history.seed([])
    await until('a later render', () => state.session.state.pendingPrompt?.id === 'row')
    expect(state.session.state.pendingPrompt, 'a seed is not its turn').toMatchObject({ id: 'row', held: true })
    expect(host.textContent).toContain(FIRST)
  })

  it.each([false, true])('restoring an existing session reuses its one process line (conversation: %s)', async (agentConversation) => {
    await page.viewport(800, 650)
    const { state, host } = mount('double', { agentConversation })
    const sentAt = Date.now() - 3000
    state.session.setPendingPrompt({ id: 'restoring-row', text: FIRST, sentAt, starting: 'restoring', held: true })
    await until('the message and its restoring label', () =>
      host.textContent?.includes(FIRST) === true && host.textContent.includes('Restoring')
    )
    expect(host.querySelectorAll('[data-user-card]')).toHaveLength(1)
    expect(host.querySelectorAll('[data-slot="turn-process"]')).toHaveLength(1)
    const message = host.querySelector<HTMLElement>('[data-user-card]')!.getBoundingClientRect()
    expect(message.right).toBeLessThanOrEqual(window.innerWidth)
    expect(message.bottom).toBeLessThanOrEqual(window.innerHeight)
    expect(host.textContent).not.toMatch(/Sending|Starting|Thinking/)

    state.session.setPendingPrompt({ id: 'restoring-row', text: FIRST, sentAt, held: true })
    await until('the existing line returns to processing', () =>
      !host.textContent?.includes('Restoring') && host.textContent?.includes('Thinking') === true
    )
    expect(host.querySelectorAll('[data-slot="turn-process"]')).toHaveLength(1)
    expect(host.querySelectorAll('[data-user-card]')).toHaveLength(1)
  })

  it('a required sign-in shows under the held first message, which no longer runs', async () => {
    const { state, host, view } = mount('double')
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
    view.setCommands({ onConditionAction: ({ index }) => [signIn][index]() })
    state.session.setCondition({
      code: 'auth-required',
      detail: 'sign-in-missing',
      label: 'Sign in to Claude to continue',
      actions: [{ label: 'Sign in' }]
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

  it('keeps the session condition row and action without exposing raw hover diagnostics', async () => {
    const { state, host, view } = mount('double');
    const retry = vi.fn();
    view.setCommands({ onConditionAction: retry });
    const label = 'Codex could not start. Update Codex, then retry.';
    state.session.setCondition({ code: 'start-failed', label, detail: 'local Codex app-server exited (code=1 signal=null)', actions: [{ label: 'Retry' }] });
    await until('condition mounts', () => Boolean(host.querySelector('[data-slot="session-condition"]')));
    const row = host.querySelector<HTMLElement>('[data-slot="session-condition"]')!;
    expect(row.textContent).toContain(label);
    expect(row.title).toBe(label);
    expect(row.outerHTML).not.toMatch(/app-server|code=1|signal=null/);
    row.querySelector<HTMLButtonElement>('button')!.click();
    expect(retry).toHaveBeenCalledOnce();
  });

  it('an action whose call is in flight is disabled: a second click does not repeat it', async () => {
    const { state, host, view } = mount('double')
    const restart = vi.fn()
    view.setCommands({ onConditionAction: restart })
    state.session.setCondition({ code: 'provider-session-missing', detail: 'missing', actions: [{ label: 'Start fresh', pending: true }] })
    await until('action mounts', () => Boolean(host.querySelector('button[data-slot="session-condition-action"]')))
    const button = host.querySelector<HTMLButtonElement>('button[data-slot="session-condition-action"]')!
    expect(button.disabled).toBe(true)
    button.click()
    expect(restart).not.toHaveBeenCalled()
  })
})

// Incoming receipts carry an envelope ID even when the provider assigns its own user-message ID.
import { renderDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope'
import type { PendingPrompt } from '@session-chat/state/pending-prompt'
const incomingText = (id: string, text: string) => renderDeliveryEnvelope({ route: 'session-direct', from: 'Agent sender', fromType: 'agent', fromId: 'session:sender', messageId: `msg:${id}`, at: '2026-11-02 04:00 UTC-8', content: text })

describe('incoming deliveries share the transcript layout', () => {
  it.each([false, true])('keeps the envelope and position through acceptance and native echo (busy=%s)', async busy => {
    const { state, host } = mount('double', { agentConversation: true, pinUserMessages: true })
    const before: TranscriptTurn = { id: 'current', seq: 0, initiator: 'user', startedAt: Date.now(), items: [{ kind: 'message', id: 'current-user', seq: 0, role: 'user', text: 'Current task' }] }
    if (busy) state.transcript.activeTurn.set(before)
    const input: PendingPrompt = { id: 'delivery', text: incomingText('source-a', 'Incoming instruction'), received: true, held: true, sentAt: Date.now(), delivery: { state: 'sending' } }
    state.session.setPendingMessages([input])
    await until('incoming sending bubble appears once with sender', () => !!host.querySelector('[data-user-card="delivery"]') && !!host.querySelector('[data-send-state="sending"]') && host.textContent!.includes('Agent sender'))
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const top = host.querySelector('[data-user-card="delivery"]')!.getBoundingClientRect().top
    state.session.setPendingMessages([{ ...input, delivery: { state: 'accepted' } }])
    await until('acceptance clears the spinner without removing the message', () => !host.querySelector('[data-send-state="sending"]'))
    expect(host.querySelector('[data-user-card="delivery"]')!.getBoundingClientRect().top).toBe(top)
    const native: TranscriptTurn = { ...(busy ? before : { id: 'native', seq: 0, initiator: 'agent' as const, startedAt: input.sentAt }), items: [...(busy ? before.items : []), { kind: 'message', id: 'provider-echo', seq: 1, role: 'user', text: input.text }] }
    state.transcript.activeTurn.set(native)
    await until('native echo takes over without a duplicate', () => !!host.querySelector('[data-user-card="provider-echo"]') && !host.querySelector('[data-user-card="delivery"]'))
    expect(host.querySelector('[data-user-card="provider-echo"]')!.getBoundingClientRect().top).toBe(top)
  })

  it('clears delivered unknown receipts with compression and a cancelled turn, without duplicating native messages', async () => {
    const { state, host, view } = mount('double', { agentConversation: true, pinUserMessages: true })
    const inputs: PendingPrompt[] = ['a', 'b', 'c'].map(id => ({ id, text: incomingText(`source-${id}`, `Incoming ${id}`), received: true, delivery: { state: 'unknown', retryable: false } }))
    const history: TranscriptTurn[] = inputs.map((input, seq) => ({ id: `turn-${seq}`, seq, initiator: 'agent', items: [
      { kind: 'message', id: `echo-${seq}`, seq: 0, role: 'user', text: input.text },
      ...(seq === 1 ? [{ kind: 'compaction' as const, id: 'compression', seq: 1, compactionId: 'cmp', status: 'in_progress' as const, summary: '', startedAt: Date.now() }] : []),
    ], ...(seq === 0 ? { outcome: { kind: 'cancelled' as const, reason: 'cancelled' as const } } : {}) }))
    state.transcript.history.seed(history)
    state.session.setPendingMessages(inputs)
    state.session.setCondition({ code: 'auth-required', detail: 'sign-in-missing', label: 'Host status remains visible' })
    for (let seq = 0; seq < 3; seq++) view.openItem(`echo-${seq}`)
    await until('all native messages replace their unknown markers', () => host.querySelectorAll('[data-user-card]').length === 3 && !host.querySelector('[data-send-state="unknown"]'))
    expect(host.querySelectorAll('[data-user-card]')).toHaveLength(3)
    expect(host.querySelectorAll('[data-send-state="unknown"] button')).toHaveLength(0)
    expect(host.textContent).toContain('Compacting')
    expect(host.textContent).toContain('Stopped')
    expect(host.textContent).toContain('Host status remains visible')
    const rows = [...host.querySelectorAll<HTMLElement>('[data-user-card]')].map(el => el.getBoundingClientRect()).sort((a, b) => a.top - b.top)
    for (let i = 1; i < rows.length; i++) expect(rows[i]!.top).toBeGreaterThan(rows[i-1]!.bottom)
    state.session.setPendingMessages([])
    await until('cleared custody preserves the native rows without a status line', () => host.querySelectorAll('[data-user-card]').length === 3 && !host.querySelector('[data-send-state="unknown"]'))
    expect([...host.querySelectorAll<HTMLElement>('[data-user-card]')].map(el => el.getBoundingClientRect().top).sort((a, b) => a - b)).toEqual(rows.map(row => row.top))
    expect(host.querySelectorAll('[data-user-card]')).toHaveLength(3)
  })
})

it('shows a sending indicator alongside the existing restoring process line without moving the input', async () => {
  const { state, host } = mount('double', { agentConversation: true })
  const input: PendingPrompt = { id: 'restoring-send', text: FIRST, held: true, starting: 'restoring', delivery: { state: 'sending' } }
  state.session.setPendingPrompt(input)
  await until('restoring and sending are visible together', () => host.textContent!.includes('Restoring') && !!host.querySelector('[data-send-state="sending"]'))
  const top = host.querySelector('[data-user-card="restoring-send"]')!.getBoundingClientRect().top
  state.session.setPendingPrompt({ ...input, delivery: { state: 'accepted' } })
  await until('acknowledgement removes the spinner while recovery continues', () => !host.querySelector('[data-send-state="sending"]'))
  expect(host.textContent).toContain('Restoring')
  expect(host.querySelector('[data-user-card="restoring-send"]')!.getBoundingClientRect().top).toBe(top)
})

it('removes the tail fallback as soon as out-of-budget native history arrives, and keeps the native identity afterward', async () => {
  const { state, host, view } = mount('double', { agentConversation: true })
  const input: PendingPrompt = { id: 'budget-fallback', text: incomingText('budget-source', 'Legacy unconfirmed input'), received: true, delivery: { state: 'unknown', retryable: false } }
  const newest: TranscriptTurn = { id: 'newer', seq: 100, initiator: 'user', items: [{ kind: 'message', id: 'newer-user', seq: 0, role: 'user', text: 'Newer input' }] }
  state.transcript.history.seed([newest])
  state.session.setPendingMessages([input])
  await until('the budget fallback is in the normal transcript', () => !!host.querySelector('[data-user-card="budget-fallback"]') && !!host.querySelector('[data-send-state="unknown"]'))
  const native: TranscriptTurn = { id: 'legacy', seq: 50, initiator: 'agent', items: [{ kind: 'message', id: 'legacy-native', seq: 0, role: 'user', text: input.text }] }
  state.transcript.history.seed([native, newest])
  view.openItem('legacy-native')
  await until('native history removes the fallback in the same handoff', () => !!host.querySelector('[data-user-card="legacy-native"]') && !host.querySelector('[data-user-card="budget-fallback"]'))
  expect(host.querySelectorAll('[data-send-state="unknown"]')).toHaveLength(0)
  state.transcript.history.prepend([{ id: 'older', seq: 10, initiator: 'user', items: [{ kind: 'message', id: 'older-user', seq: 0, role: 'user', text: 'Earlier history' }] }])
  await until('an unrelated older page has rendered', () => !!host.querySelector('[data-user-card="older-user"]'))
  expect(host.querySelectorAll('[data-user-card="legacy-native"]')).toHaveLength(1)
  expect(host.querySelector('[data-user-card="budget-fallback"]')).toBeNull()
  expect(host.querySelectorAll('[data-send-state="unknown"]')).toHaveLength(0)
  state.transcript.history.seed([newest])
  await until('a narrower history window omits the native row', () => !host.querySelector('[data-user-card="legacy-native"]'))
  expect(host.querySelector('[data-user-card="budget-fallback"]')).toBeNull()
  state.transcript.history.seed([native, newest])
  view.openItem('legacy-native')
  await until('the same native identity returns without a false unresolved marker', () => !!host.querySelector('[data-user-card="legacy-native"]') && !host.querySelector('[data-send-state="unknown"]'))
  expect(host.querySelector('[data-user-card="budget-fallback"]')).toBeNull()
})
