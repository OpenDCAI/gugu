// @vitest-environment jsdom
//
// owner 2026-10-16:一轮的过程折叠里,连着的工具调用收成一组 —— 跑着时自己摊开的、跑完后人点开的都一样,
// 同桌面的「跑了 N 条命令」(推翻 10-02「过程折叠里直接摆工具卡」:跑着时「执行、执行、执行」一直平铺)。
// 一条就是一行,不套「1 次工具调用」。
import { act } from 'react'
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

const turns = [{
  id: 't1',
  seq: 1,
  initiator: 'user',
  items: [
    { kind: 'message', id: 'u1', seq: 0, role: 'user', text: 'list files' },
    { kind: 'tool-call', id: 'tc1', seq: 1, title: 'Bash', status: 'done', rawInput: '{"command":"ls -la"}' },
    { kind: 'tool-call', id: 'tc2', seq: 2, title: 'Bash', status: 'running', rawInput: '{"command":"sleep 25"}' },
  ],
}] as unknown as TranscriptTurn[]

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

const render = (timeline: TranscriptTurn[], agentWorking: boolean) =>
  harness.render(
    <AgentThread
      timeline={{ ...emptyAgentWatchTimeline(), turns: timeline }}
      deviceId="device-1"
      sessionId="conversation-1"
      sessionRuntime="pty"
      respondingItemId={null}
      onRespond={() => undefined}
      onSend={async () => undefined}
      pendingSends={[]}
      sending={false}
      agentWorking={agentWorking}
      onStop={() => undefined}
      stopping={false}
      onLoadOlder={async () => undefined}
    />,
  )
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
const triggers = (root: Element) => [...root.querySelectorAll<HTMLElement>('[data-slot="tool-group-trigger"]')]

describe('手机会话页:一轮里连着的工具调用收成一组', () => {
  it('人点开跑完的那一轮,连着的两条命令仍是一组,再点开才逐条', async () => {
    const done = [{
      ...turns[0],
      outcome: { kind: 'done' },
      items: [
        ...(turns[0].items as unknown[]).map((item) => ({ ...(item as object), status: 'done' })),
        { kind: 'message', id: 'a1', seq: 3, role: 'assistant', text: 'listed' },
      ],
    }] as unknown as TranscriptTurn[]
    await render(done, false)
    await settle()
    const fold = harness.container.querySelector('[data-slot="turn-process"]')
    expect(fold?.getAttribute('data-expanded'), 'a finished turn should start closed').toBe('false')
    await act(async () => { triggers(fold!)[0].click() })
    expect(fold?.getAttribute('data-expanded')).toBe('true')
    expect(triggers(fold!).length, 'the opened turn laid its calls out flat').toBe(2)
    expect(fold!.textContent).not.toContain('sleep 25')
    // 阳控:点开那一组,两条都在。
    await act(async () => { triggers(fold!)[1].click() })
    expect(fold!.textContent).toContain('ls -la')
    expect(fold!.textContent).toContain('sleep 25')
  })

  it('跑着的那一轮自己摊开,连着的两条命令收成一组(owner 2026-10-16)', async () => {
    await render(turns, true)
    await settle()
    const fold = harness.container.querySelector('[data-slot="turn-process"]')
    expect(fold?.getAttribute('data-expanded'), 'the live turn should be open').toBe('true')
    expect(triggers(fold!).length, 'the live turn laid its calls out flat').toBe(2)
    expect(fold!.textContent).not.toContain('sleep 25')
    // 阳控:点开那一组,两条都在。
    await act(async () => { triggers(fold!)[1].click() })
    expect(fold!.textContent).toContain('ls -la')
    expect(fold!.textContent).toContain('sleep 25')
  })

  it('一条就是一行:跑着的一轮里只有一条调用时 ❌ 再套「1 次工具调用」', async () => {
    const one = [{ ...turns[0], items: (turns[0].items as unknown[]).slice(0, 2) }] as unknown as TranscriptTurn[]
    await render(one, true)
    await settle()
    const fold = harness.container.querySelector('[data-slot="turn-process"]')
    expect(fold!.textContent).toContain('ls -la')
    expect(triggers(fold!).length, 'a single call got its own group').toBe(1)
  })

  it('思考夹在命令中间也进同一组,头上写桌面同一句;agent 说的话把它劈开(owner 2026-10-16)', async () => {
    const think = (id: string, seq: number) => ({ kind: 'thinking', id, seq, status: 'done', text: `想一下 ${id}`, startedAt: 0, durationMs: 400 })
    const bash = (id: string, seq: number, command: string) =>
      ({ kind: 'execute-tool-call', id, seq, toolCallId: id, title: 'Bash', status: 'done', command, rawInput: JSON.stringify({ command }) })
    const mixed = [{
      id: 't3', seq: 3, initiator: 'user',
      items: [
        { kind: 'message', id: 'u3', seq: 0, role: 'user', text: 'go' },
        think('th1', 1), bash('b1', 2, 'echo one'), think('th2', 3), bash('b2', 4, 'echo two'),
        { kind: 'message', id: 'mid', seq: 5, role: 'assistant', text: '中途说一句' },
        think('th3', 6), bash('b3', 7, 'echo three'), bash('b4', 8, 'echo four'),
      ],
    }] as unknown as TranscriptTurn[]
    await render(mixed, true)
    await settle()
    const fold = harness.container.querySelector('[data-slot="turn-process"]')
    expect(fold?.getAttribute('data-expanded'), 'the live turn should be open').toBe('true')
    // 中途那句话前后各一组:前一组在时间头里(过程),后一组跟着那句话在头外面(还在跑的尾巴,同桌面)。
    const groupTriggers = triggers(harness.container).filter((t) => !t.closest('[data-slot="turn-process"]') || t.closest('[data-slot="turn-process"] [data-slot="tool-group-root"] [data-slot="tool-group-root"]'))
    const labels = groupTriggers.map((t) => t.textContent?.replace(/\s+/g, ' ').trim())
    expect(labels, `groups: ${JSON.stringify(labels)}`).toHaveLength(2)
    expect(labels[0]).toMatch(/思考了 2 次、跑了 2 条命令|Thought 2 times, ran 2 shell commands/)
    expect(labels[1]).toMatch(/思考了 1 次、跑了 2 条命令|Thought 1 time, ran 2 shell commands/)
    expect(harness.container.textContent, 'the sentence between the two groups is gone').toContain('中途说一句')
    // 收着的时候一条命令都不画;阳控:点开第一组,它那两条命令都在。
    expect(harness.container.textContent).not.toContain('echo one')
    await act(async () => { groupTriggers[0].click() })
    expect(harness.container.textContent).toContain('echo one')
    expect(harness.container.textContent).toContain('echo two')
  })

  it('没有时间头的一轮(agent 自发)里,工具调用照旧收成一组 —— 同桌面的语义折叠', async () => {
    const agentTurn = [{
      id: 't2',
      seq: 2,
      initiator: 'agent',
      outcome: { kind: 'done' },
      items: [
        { kind: 'tool-call', id: 'tc3', seq: 0, title: 'Bash', status: 'done', rawInput: '{"command":"echo a"}' },
        { kind: 'tool-call', id: 'tc4', seq: 1, title: 'Bash', status: 'done', rawInput: '{"command":"echo b"}' },
      ],
    }] as unknown as TranscriptTurn[]
    await harness.render(
      <AgentThread
        timeline={{ ...emptyAgentWatchTimeline(), turns: agentTurn }}
        deviceId="device-1"
        sessionId="conversation-1"
        sessionRuntime="pty"
        respondingItemId={null}
        onRespond={() => undefined}
        onSend={async () => undefined}
        pendingSends={[]}
        sending={false}
        agentWorking={false}
        onStop={() => undefined}
        stopping={false}
        onLoadOlder={async () => undefined}
      />,
    )
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(harness.container.querySelector('[data-slot="turn-process"]'), 'an agent-initiated turn grew a time header').toBeNull()
    expect(harness.container.querySelectorAll('[data-slot="tool-group-trigger"]').length).toBe(1)
  })
})
