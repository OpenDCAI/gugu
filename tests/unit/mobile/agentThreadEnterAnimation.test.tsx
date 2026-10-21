// @vitest-environment jsdom
//
// 2026-09-29 手机新建会话:首句带到会话页后,那一行在会话页挂上时又从透明淡入一遍 —— 看着就是「没了又出来」。
// 线程挂上那一刻已在线上的行不是新到的,不播入场动画;之后追加的行照播。
import { readFileSync } from 'node:fs'
import { act, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TranscriptTurn } from '@gugu/session-core/acp/client'
import { createReactHarness } from '../../support/testHarness'

vi.mock('../../../apps/desktop/src/mobile/agent-watch/sessionpage-rpc', () => ({
  SessionpageRpcError: class SessionpageRpcError extends Error {},
  fetchSessionOptions: vi.fn(() => new Promise(() => {})),
  setSessionOption: vi.fn(),
  sessionAttachmentRpc: vi.fn(() => ({})),
}))

const { AgentThread } = await import('../../../apps/desktop/src/mobile/agent-watch/AgentThread')
const { emptyAgentWatchTimeline } = await import('../../../apps/desktop/src/mobile/agent-watch/agent-watch-store')

const FIRST = { id: 'pending:first', text: '帮我看看今天的构建为什么红了', baseline: new Set<string>(), accepted: true }
const reply: TranscriptTurn = {
  id: 't1', seq: 1, initiator: 'user',
  items: [
    { kind: 'message', id: 'u1', seq: 0, role: 'user', text: FIRST.text },
    { kind: 'message', id: 'a1', seq: 1, role: 'assistant', text: '好的,我去看。' },
  ],
} as unknown as TranscriptTurn

function thread(turns: TranscriptTurn[], pending: typeof FIRST[], agentWorking = false, emptyNote?: ReactNode) {
  return (
    <AgentThread
      timeline={{ ...emptyAgentWatchTimeline(), turns }}
      deviceId="device-1"
      sessionId="conversation-1"
      sessionRuntime="acp"
      respondingItemId={null}
      onRespond={() => undefined}
      onSend={async () => undefined}
      pendingSends={pending}
      sending={false}
      agentWorking={agentWorking}
      onStop={() => undefined}
      stopping={false}
      onLoadOlder={async () => undefined}
      emptyNote={emptyNote}
    />
  )
}

let harness: ReturnType<typeof createReactHarness>
const scrollTo = Element.prototype.scrollTo
beforeEach(() => {
  Element.prototype.scrollTo = () => undefined
  harness = createReactHarness()
})
afterEach(() => {
  harness.cleanup()
  Element.prototype.scrollTo = scrollTo
})

const row = (role: string) => harness.container.querySelector(`[data-role="${role}"]`)

describe('会话页挂上时已在线上的那句不再淡入一遍', () => {
  it('挂上时就在的首句不带入场动画;记录顶替它、agent 回话追加进来,回话照常入场', async () => {
    await harness.render(thread([], [FIRST]))
    expect(row('user')?.className).not.toMatch(/animate-in/)
    await harness.render(thread([reply], []))
    expect(row('user')?.textContent).toContain(FIRST.text)
    expect(row('user')?.className).not.toMatch(/animate-in/)
    expect(row('assistant')?.className).toMatch(/animate-in/)
  })
})

// 2026-10-12 owner 手机实测:进运行中的任务页,线程先空着挂上,读进来的整段历史全都从透明淡入 + 上滑一遍
// (只剩不带动画的过程头孤零零一行),看着就是「进去就颤两下」。空着挂上、第一批才到的是历史,不是新到的。
describe('空着挂上的线程,第一批读进来的是历史,❌ 播入场', () => {
  const later: TranscriptTurn = {
    id: 't2', seq: 2, initiator: 'user',
    items: [{ kind: 'message', id: 'u2', seq: 0, role: 'user', text: '再看一下测试' }],
  } as unknown as TranscriptTurn

  it('第一批不带入场动画;之后追加的照常入场(阳控)', async () => {
    await harness.render(thread([], []))
    expect(row('user')).toBeNull()
    await harness.render(thread([reply], []))
    expect(row('user')?.className).not.toMatch(/animate-in/)
    expect(row('assistant')?.className).not.toMatch(/animate-in/)
    await harness.render(thread([reply, later], []))
    const users = [...harness.container.querySelectorAll('[data-role="user"]')]
    expect(users.at(-1)?.textContent).toContain('再看一下测试')
    expect(users.at(-1)?.className).toMatch(/animate-in/)
  })
})

// 评审 10-12:过程折叠里「挂上时就摊开」的内容不播入场(agent-watch.css 那条规则),但之后才来的一轮照播。
// 官方 ToolGroupContent 的入场挂在内容 div 的**直接子元素**上;折叠里只有一个直接子元素 —— 这一轮的消息根,
// 工具行都在消息根里面,所以后来的工具行本来就不受那条入场管。跑着的一轮里连着的工具调用收成一组(owner 10-16),
// 那一组是消息根里面的东西;人点开它时它自己的内容照常入场,❌ 被时间头那条静音规则连带。
// jsdom 不加载 Tailwind,量不到动画;这里拿 agent-watch.css 里那条规则的原文选择器对真渲染的 DOM 判「被静音的是谁」。
describe('过程折叠:挂上时就摊开的内容不播入场,之后来的一轮照播', () => {
  const css = readFileSync('apps/desktop/src/mobile/agent-watch/agent-watch.css', 'utf8')
  const stilledBy = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{\s*animation:\s*none;\s*\}/g)]
    .map((m) => m[1].trim())
    .filter((selector) => selector.includes('turn-process'))
  const stilled = (el: Element) => stilledBy.some((selector) => el.matches(selector))
  const tool = (id: string, seq: number, command: string, status = 'done') =>
    ({ kind: 'tool-call', id, seq, title: 'Bash', status, rawInput: JSON.stringify({ command }) })
  const turn = (id: string, seq: number, items: unknown[], done = false) =>
    ({ id, seq, initiator: 'user', ...(done ? { outcome: { kind: 'done' } } : {}), items }) as unknown as TranscriptTurn
  const t1 = (...tools: unknown[]) => turn('t1', 1, [{ kind: 'message', id: 'u1', seq: 0, role: 'user', text: 'list files' }, ...tools])
  const t2 = turn('t2', 2, [{ kind: 'message', id: 'u2', seq: 0, role: 'user', text: 'and the tests' }, tool('tc9', 1, 'pnpm test', 'running')])
  const show = async (turns: TranscriptTurn[]) => {
    await harness.render(<div className="gg-aw">{thread(turns, [], true)}</div>)
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  }
  const contentChildren = (fold: Element) => [...fold.querySelectorAll('[data-slot="tool-group-content"] > div > *')]
  const folds = () => [...harness.container.querySelectorAll('[data-slot="turn-process"]')]

  it('在跑的那一轮挂上时就摊开:内容静音;它里面后来的工具行也在消息根里;之后来的一轮内容照播', async () => {
    expect(stilledBy.length, 'the turn-process stilling rule is gone from agent-watch.css').toBe(1)
    await show([t1(tool('tc1', 1, 'ls -la'))])
    const [first] = folds()
    expect(first.getAttribute('data-expanded')).toBe('true')
    expect(contentChildren(first).map(stilled)).toEqual([true])

    await show([t1(tool('tc1', 1, 'ls -la'), tool('tc2', 2, 'sleep 25', 'running'))])
    // 跑着的一轮自己摊开,里面连着的两条命令照样收成一组 —— ❌ 平铺成两张卡(owner 10-16)。
    const groups = () => [...folds()[0].querySelectorAll('[data-slot="tool-group-root"] [data-slot="tool-group-root"]')]
    expect(groups(), 'the live turn laid its tool calls out flat instead of grouping them').toHaveLength(1)
    expect(folds()[0].textContent, 'a grouped call is still drawn while the group is closed').not.toContain('sleep 25')
    expect(contentChildren(folds()[0]), 'a tool row became a direct child of the fold content').toHaveLength(1)
    // 人点开那一组:它的内容照常入场,不归时间头的静音管。
    await act(async () => { (groups()[0].querySelector('[data-slot="tool-group-trigger"]') as HTMLElement).click() })
    expect(folds()[0].textContent).toContain('sleep 25')
    const opened = [...groups()[0].querySelectorAll(':scope > [data-slot="tool-group-content"] > div > *')]
    expect(opened.length, 'the opened group drew no rows').toBeGreaterThan(0)
    expect(opened.map(stilled), 'the stilling rule reached into a group the reader opened').toEqual(opened.map(() => false))

    await show([turn('t1', 1, t1(tool('tc1', 1, 'ls -la'), tool('tc2', 2, 'sleep 25')).items, true), t2])
    const latest = folds().at(-1)!
    expect(latest.textContent).toContain('pnpm test')
    expect(latest.getAttribute('data-expanded')).toBe('true')
    expect(contentChildren(latest).map(stilled), 'a turn that arrived after mount lost its entrance').toEqual([false])
  })
})

// 2026-10-12 owner「进去就颤两下」的第一下:时间线还在读时,线程画的是官方空态(「这条任务还没有内容」,自带入场),
// 页上方另有一行 loading;读进来后两样一起撤掉 ⇒ 先空几帧、整条线程再上移。读取中 / 等它开口那一句画在线程自己的空态位上。
describe('线程空着时画调用方给的那一句,❌ 官方空态', () => {
  const note = <div data-testid="aw-empty-note">Loading this task…</div>
  const welcome = () => harness.container.querySelector('.aui-thread-welcome-root')

  it('给了那一句:画它,官方空态不出现;没给:官方空态(阳控:选择器认得出它)', async () => {
    await harness.render(thread([], [], false, note))
    expect(harness.container.querySelector('[data-testid="aw-empty-note"]')).not.toBeNull()
    expect(welcome(), 'the official empty state is back').toBeNull()
    harness.cleanup()
    harness = createReactHarness()
    await harness.render(thread([], []))
    expect(welcome()).not.toBeNull()
  })
})
