/**
 * #5003 · 合批归队列属主(spec session-injection「合批归队列属主;注入口没有队列」)。
 *
 * 可见域:读者(pull 批)→ conversation 键控注入口 → local-session 认领者 → 假 pty 绑定。
 * 判的是**咕咕这一层**:TUI keystroke 腿没有 gugu 侧队列;reader 每条输入逐一 admission,
 * 注入口与 local-session 腿没有队列 —— 一次注入 = 一次提交,不因忙扣消息。harness 自己是否把这些
 * 提交折成一轮不属于 gugu 侧读数。
 * harness 自己的输入缓冲怎么抽(qwen「Enter to steer」在下一个工具边界折成一条)归 harness,
 * 读数在 gugu-base `evidence/2026-09-04-qwen-tui-3msg-steer-fold-5003`,不在这里。
 *
 * 三条判据各带能红的对照:(a)/(b) 同一断言、只差「三行在几次 pull 里」这一个自由度;
 * (c) 同一断言喂给一个「忙时先攒、回合末再发」的变异认领者 —— 那正是本节点禁止在 TUI 侧再造的
 * 第二个合批产地,断言必须红在它身上。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  SessionpageLocalDeliveryRouter,
  type SessionpageDeliveryTarget,
} from '../../../../apps/desktop/electron/sessionpage/session-injection'
import {
  localSessionDeliveryTarget,
  registerLocalSessionDelivery,
  unregisterLocalSessionDelivery,
  type LocalSessionMessage,
} from '../../../../apps/desktop/electron/sessionpage/local-session-delivery'
import {
  pullAgentInbox,
  resetAgentInboxReaderStateForTests,
  type AgentInboxReaderDeps,
  type AgentInboxUnreadRow,
} from '@gugu/core/local/agent/agentInboxReader'
import { memoryGroupRulesLedger } from '@gugu/core/local/agent/groupRulesDelivery'

const AGENT = 'agent-0000-0000-0000-000000005003'
const HUMAN = 'human-0000-0000-0000-000000005003'
const CONV = 'conv-5003'
const CHAT = 'chat-5003'

function unreadRow(id: string, seq: number): AgentInboxUnreadRow {
  return {
    chatId: CHAT,
    chatKind: 'dm',
    chatPublicId: 42,
    chatName: 'dm-5003',
    chatCreatorUserId: HUMAN,
    listenMode: 'active',
    notificationLevel: 'all',
    lastReadSeq: 0,
    id,
    seq,
    senderUserId: HUMAN,
    senderType: 'human',
    senderDisplayName: 'Ada',
    senderGuguNumber: null,
    content: `message ${id}`,
    contentType: 'text',
    toUserIds: [AGENT],
    isWhisper: false,
    replyToMessageId: null,
    replyToSenderUserId: null,
    replyToContent: null,
    threadRootId: null,
    isThreadRoot: false,
    createdAt: '2026-09-04T12:00:00.000Z',
  }
}

/** 假 pty 绑定:每次 sendMessage = harness 收到一次提交(payload + 提交键),原样记账。 */
function bindFakePty(): { submissions: string[] } {
  const submissions: string[] = []
  registerLocalSessionDelivery(AGENT, {
    sessionId: CONV,
    providerId: 'qwen',
    sendMessage: async (message: LocalSessionMessage) => {
      submissions.push(message.text)
      return { status: 'accepted', messageId: message.id }
    },
  })
  return { submissions }
}

function readerDeps(
  router: SessionpageLocalDeliveryRouter,
  queue: AgentInboxUnreadRow[][],
): AgentInboxReaderDeps {
  return {
    accessToken: 'owner-token',
    fetchChatFacts: async () => null,
    groupRulesLedger: memoryGroupRulesLedger(),
    inject: (input) => router.injectForAgentWithCompletion(input.agentUserId, {
      id: input.messageId ?? 'no-id',
      text: input.text,
    }),
    fetchUnread: async () => queue.shift() ?? [],
    markRead: async () => {},
  }
}

function envelopeSegments(text: string): number {
  return text.split('<gugu_delivery ').length - 1
}

beforeEach(() => {
  resetAgentInboxReaderStateForTests()
  unregisterLocalSessionDelivery(CONV)
})

describe('#5003 合批归队列属主:TUI keystroke 腿不由 gugu 预合批', () => {
  it('同一次 pull 的三条无附件行到 local-session 腿逐条立即提交', async () => {
    const { submissions } = bindFakePty()
    const router = new SessionpageLocalDeliveryRouter([localSessionDeliveryTarget])
    const rows = [unreadRow('m1', 1), unreadRow('m2', 2), unreadRow('m3', 3)]

    const result = await pullAgentInbox(AGENT, readerDeps(router, [rows]))

    expect(result).toMatchObject({ pulled: 3, injected: 3, verdict: 'accepted' })
    expect(submissions).toHaveLength(3)
    expect(submissions.map(envelopeSegments)).toEqual([1, 1, 1])
    expect(submissions.map((text) => /msg="msg:(m\d)"/.exec(text)?.[1])).toEqual(['m1', 'm2', 'm3'])
  })

  it('对照:同三条各在自己的 pull 里到达 ⇒ 三次提交 —— 批是 pull 的,不是这条腿的', async () => {
    const { submissions } = bindFakePty()
    const router = new SessionpageLocalDeliveryRouter([localSessionDeliveryTarget])
    const deps = readerDeps(router, [[unreadRow('m1', 1)], [unreadRow('m2', 2)], [unreadRow('m3', 3)]])

    await pullAgentInbox(AGENT, deps)
    await pullAgentInbox(AGENT, deps)
    await pullAgentInbox(AGENT, deps)

    expect(submissions).toHaveLength(3)
    expect(submissions.map(envelopeSegments)).toEqual([1, 1, 1])
    expect(submissions.map((text) => /msg="msg:(m\d)"/.exec(text)?.[1])).toEqual(['m1', 'm2', 'm3'])
  })

  it('一次注入 = 一次立即提交:三次直注中间没有任何回合末事件,三条按序全部写出', async () => {
    const { submissions } = bindFakePty()
    const router = new SessionpageLocalDeliveryRouter([localSessionDeliveryTarget])

    for (const id of ['d1', 'd2', 'd3']) {
      const verdict = await router.injectForAgent(AGENT, { id, text: `direct ${id}` })
      expect(verdict).toBe('accepted')
    }

    assertOneSubmissionPerInjection(submissions, ['d1', 'd2', 'd3'])
  })

  it('必失败对照:一个「忙时先攒、回合末合成一条再发」的认领者让同一断言变红 —— 那就是本票禁止的第二个合批产地', async () => {
    const mutant = holdingClaimantMutant()
    const router = new SessionpageLocalDeliveryRouter([mutant.target])

    for (const id of ['h1', 'h2', 'h3']) {
      expect(await router.injectForAgent(AGENT, { id, text: `direct ${id}` })).toBe('accepted')
    }

    // 同一条断言:注入口报了三次 accepted,harness 却一次提交都没收到 —— 字节被扣在 gugu 手里。
    expect(() => assertOneSubmissionPerInjection(mutant.submissions, ['h1', 'h2', 'h3'])).toThrow()
    // 它在回合末才把攒下的合成一条 —— 这正是 ACP 会话机那份出队策略的平行副本,在 TUI 侧不许存在。
    mutant.turnEnd()
    expect(mutant.submissions).toEqual(['direct h1\n\ndirect h2\n\ndirect h3'])
  })
})

/** (c)/(d) 共用的那条断言:每次注入恰好一次提交,顺序不变。 */
function assertOneSubmissionPerInjection(submissions: readonly string[], ids: readonly string[]): void {
  expect(submissions).toEqual(ids.map((id) => `direct ${id}`))
}

/** 变异认领者:忙时把字节攒在自己手里、回合末合成一条发出(TUI 侧的平行合批实现)。 */
function holdingClaimantMutant(): {
  target: SessionpageDeliveryTarget
  submissions: string[]
  turnEnd(): void
} {
  const held: string[] = []
  const submissions: string[] = []
  const target: SessionpageDeliveryTarget = {
    deliveryTargetName: 'mutant-holding-tui',
    liveSessionIdByAgent: (agentUserId) => (agentUserId === AGENT ? CONV : null),
    deliveryKeyForSession: (sessionId) => (sessionId === CONV ? CONV : null),
    sessionProviderSurface: (key) => (key === CONV ? { providerId: 'claude', surface: 'tui' } : null),
    tryInjectSessionMessage: async (_sessionId, message) => {
      held.push(message.text)
      return true
    },
  }
  return {
    target,
    submissions,
    turnEnd() {
      if (held.length > 0) submissions.push(held.splice(0).join('\n\n'))
    },
  }
}
