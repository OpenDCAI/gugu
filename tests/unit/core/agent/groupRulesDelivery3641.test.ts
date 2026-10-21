/**
 * #3641 群规主动送达(spec gugu-plugin「会话态必达，变更即重达」)。
 *
 * 旧形状:群规只在 agent 发言时被 MCP 发送闸拦一次 ⇒ 决定沉默的 agent 永远见不到群规,
 * 决定回不回的那一刻也没见过。这里钉住新形状:
 *   · 投递读者在 agent 这段上下文没收到过当前版本时,随该群第一条投递附上原文;
 *   · 送达记录落盘、跨进程重启仍在;上下文一换(provider 新 session)即重达;群规一改即重达;
 *   · 每条群投递都带版本号,同批只附一次原文。
 * 每条否定断言都有正对照。
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  pullAgentInbox,
  resetAgentInboxReaderStateForTests,
  type AgentInboxInjectionInput,
  type AgentInboxReaderDeps,
  type AgentInboxUnreadRow,
} from '@gugu/core/local/agent/agentInboxReader'
import {
  decideGroupRulesDelivery,
  effectiveGroupRules,
  groupRulesLedgerAt,
  groupRulesVersion,
  memoryGroupRulesLedger,
  resetGroupRulesLedgersForTests,
  type ChatFactsRow,
  type GroupRulesLedger,
} from '@gugu/core/local/agent/groupRulesDelivery'
import { renderDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope'

const AGENT = 'agent-3641'
const HUMAN = 'human-3641'

function row(id: string, seq: number, over: Partial<AgentInboxUnreadRow> = {}): AgentInboxUnreadRow {
  return {
    chatId: 'g1', chatKind: 'group', chatPublicId: 7, chatName: 'g', chatCreatorUserId: HUMAN,
    listenMode: 'active', notificationLevel: 'all', lastReadSeq: 0,
    id, seq, senderUserId: HUMAN, senderType: 'human', senderDisplayName: 'Ada',
    senderGuguNumber: null, content: `body ${id}`, contentType: 'text', toUserIds: null, isWhisper: false,
    replyToMessageId: null, replyToSenderUserId: null, replyToContent: null,
    threadRootId: null, isThreadRoot: false, createdAt: '2026-09-23T10:00:00.000Z',
    ...over,
  }
}

function harness(opts: {
  facts: Record<string, ChatFactsRow>
  ledger?: GroupRulesLedger
  contextKey?: () => string | null
}) {
  const unread: AgentInboxUnreadRow[] = []
  const injected: AgentInboxInjectionInput[] = []
  const factReads: string[] = []
  const deps: AgentInboxReaderDeps = {
    accessToken: 'owner-token',
    fetchUnread: async () => unread.splice(0),
    markRead: async () => {},
    inject: async (input) => { injected.push(input); return 'accepted' },
    fetchChatFacts: async (chatId, asUserId) => {
      expect(asUserId).toBe(AGENT)
      factReads.push(chatId)
      return opts.facts[chatId] ?? null
    },
    groupRulesLedger: opts.ledger ?? memoryGroupRulesLedger(),
    ...(opts.contextKey ? { deliveryContextKey: opts.contextKey } : {}),
  }
  return { deps, unread, injected, factReads }
}

const group = (prompt: string | null): ChatFactsRow => ({ kind: 'group', source_chat_id: null, group_prompt: prompt })

beforeEach(() => {
  resetAgentInboxReaderStateForTests()
  resetGroupRulesLedgersForTests()
})

describe('decideGroupRulesDelivery', () => {
  it('从没送达 ⇒ 附原文;同一上下文同一版本 ⇒ 不附(正对照)', () => {
    const first = decideGroupRulesDelivery({ rules: '规矩A', delivered: null, contextKey: 'k1' })
    expect(first).toEqual({ version: groupRulesVersion('规矩A'), text: '规矩A' })
    expect(decideGroupRulesDelivery({ rules: '规矩A', delivered: { version: first.version, contextKey: 'k1' }, contextKey: 'k1' }).text).toBeNull()
  })
  it('版本变了 / 上下文换了 ⇒ 重达', () => {
    const v = groupRulesVersion('规矩A')
    expect(decideGroupRulesDelivery({ rules: '规矩B', delivered: { version: v, contextKey: 'k1' }, contextKey: 'k1' }).text).toBe('规矩B')
    expect(decideGroupRulesDelivery({ rules: '规矩A', delivered: { version: v, contextKey: 'k1' }, contextKey: 'k2' }).text).toBe('规矩A')
  })
  it('群规清空:同一上下文里送达过 ⇒ 告诉它撤了;从没送达过 ⇒ 什么都不说', () => {
    const v = groupRulesVersion('规矩A')
    expect(decideGroupRulesDelivery({ rules: '  ', delivered: { version: v, contextKey: 'k1' }, contextKey: 'k1' }).text).toBe('')
    expect(decideGroupRulesDelivery({ rules: '', delivered: null, contextKey: 'k1' }).text).toBeNull()
    expect(decideGroupRulesDelivery({ rules: '', delivered: { version: v, contextKey: 'k1' }, contextKey: 'k2' }).text).toBeNull()
  })
})

describe('effectiveGroupRules', () => {
  it('话题没立规矩时沿用来源群;自己立了就用自己的', async () => {
    const facts: Record<string, ChatFactsRow> = {
      g1: group('群规矩'),
      t1: { kind: 'topic', source_chat_id: 'g1', group_prompt: null },
      t2: { kind: 'topic', source_chat_id: 'g1', group_prompt: '话题规矩' },
    }
    const read = async (id: string) => facts[id] ?? null
    expect(await effectiveGroupRules('t1', read)).toBe('群规矩')
    expect(await effectiveGroupRules('t2', read)).toBe('话题规矩')
    expect(await effectiveGroupRules('nope', read)).toBe('')
  })
})

describe('读者随投递送达群规', () => {
  it('首条群投递附原文,同批第二条只带版本;下一批不再附(同一上下文)', async () => {
    const h = harness({ facts: { g1: group('先给检索式再给结论。') } })
    h.unread.push(row('m1', 1), row('m2', 2))
    await pullAgentInbox(AGENT, h.deps)
    const version = groupRulesVersion('先给检索式再给结论。')
    expect(h.injected[0]!.text).toContain(`<group_rules version="${version}"><![CDATA[先给检索式再给结论。]]></group_rules>`)
    expect(h.injected[0]!.text).toContain(`rules="${version}"`)
    expect(h.injected[1]!.text).toContain(`rules="${version}"`)
    expect(h.injected[1]!.text).not.toContain('<group_rules')
    h.unread.push(row('m3', 3))
    await pullAgentInbox(AGENT, h.deps)
    expect(h.injected[2]!.text).toContain(`rules="${version}"`)
    expect(h.injected[2]!.text).not.toContain('<group_rules')
  })

  it('决定沉默的 agent 也收到了群规 —— 送达不依赖它发言', async () => {
    // 这一格是旧设计的洞:唯一通道在发送闸,不发言就永远见不到。这里 agent 只被投递、从不调用发送工具。
    const h = harness({ facts: { g1: group('无人点名时只由组长回答') } })
    h.unread.push(row('m1', 1))
    await pullAgentInbox(AGENT, h.deps)
    expect(h.injected).toHaveLength(1)
    expect(h.injected[0]!.text).toContain('无人点名时只由组长回答')
  })

  it('群规改了 ⇒ 下一次投递前重达新版', async () => {
    const facts = { g1: group('规矩A') }
    const h = harness({ facts })
    h.unread.push(row('m1', 1))
    await pullAgentInbox(AGENT, h.deps)
    facts.g1 = group('规矩B')
    h.unread.push(row('m2', 2))
    await pullAgentInbox(AGENT, h.deps)
    expect(h.injected[1]!.text).toContain('<![CDATA[规矩B]]>')
  })

  it('会话换了新的 provider 上下文 ⇒ 重达;同一上下文 ⇒ 不重复(正对照)', async () => {
    let key = 'conv:session-1'
    const h = harness({ facts: { g1: group('规矩A') }, contextKey: () => key })
    h.unread.push(row('m1', 1))
    await pullAgentInbox(AGENT, h.deps)
    h.unread.push(row('m2', 2))
    await pullAgentInbox(AGENT, h.deps)
    expect(h.injected[1]!.text).not.toContain('<group_rules')
    key = 'conv:session-2'
    h.unread.push(row('m3', 3))
    await pullAgentInbox(AGENT, h.deps)
    expect(h.injected[2]!.text).toContain('<![CDATA[规矩A]]>')
  })

  it('送达记录落盘:进程内存清空后(重启)不重复送达;文件里记的是版本与上下文', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'gugu-3641-')), 'delivery', 'group-rules-delivered.json')
    const h = harness({ facts: { g1: group('规矩A') }, ledger: groupRulesLedgerAt(path), contextKey: () => 'conv:s1' })
    h.unread.push(row('m1', 1))
    await pullAgentInbox(AGENT, h.deps)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      [AGENT]: { g1: { version: groupRulesVersion('规矩A'), contextKey: 'conv:s1' } },
    })
    // 模拟重启:两份进程内状态都清空,只剩盘上的记录。
    resetAgentInboxReaderStateForTests()
    resetGroupRulesLedgersForTests()
    h.deps.groupRulesLedger = groupRulesLedgerAt(path)
    h.unread.push(row('m2', 2))
    await pullAgentInbox(AGENT, h.deps)
    expect(h.injected[1]!.text).not.toContain('<group_rules')
  })

  it('注入没被受理(not-live)⇒ 不记已送达,下次照附(否则会记下一次它根本没看到的送达)', async () => {
    const h = harness({ facts: { g1: group('规矩A') } })
    let verdict: 'not-live' | 'accepted' = 'not-live'
    h.deps.inject = async (input) => { h.injected.push(input); return verdict }
    h.deps.fetchUnread = async () => [row('m1', 1)]
    await pullAgentInbox(AGENT, h.deps)
    verdict = 'accepted'
    await pullAgentInbox(AGENT, h.deps)
    expect(h.injected).toHaveLength(2)
    expect(h.injected[1]!.text).toContain('<![CDATA[规矩A]]>')
  })

  it('私聊与没立规矩的群:不读、不带任何群规格子', async () => {
    const h = harness({ facts: { g2: group(null) } })
    h.unread.push(row('d1', 1, { chatId: 'dm1', chatKind: 'dm' }), row('m1', 1, { chatId: 'g2' }))
    await pullAgentInbox(AGENT, h.deps)
    expect(h.factReads).toEqual(['g2'])
    for (const input of h.injected) {
      expect(input.text).not.toContain('rules=')
      expect(input.text).not.toContain('<group_rules')
    }
  })

  it('话题投递沿用来源群的规矩', async () => {
    const h = harness({ facts: { g1: group('群规矩'), t1: { kind: 'topic', source_chat_id: 'g1', group_prompt: null } } })
    h.unread.push(row('m1', 1, { chatId: 't1', chatKind: 'topic' }))
    await pullAgentInbox(AGENT, h.deps)
    expect(h.injected[0]!.text).toContain('<![CDATA[群规矩]]>')
  })

  it('群规读失败 ⇒ 这批不注入(❌ 在没见过群规的情况下照投)', async () => {
    const h = harness({ facts: {} })
    h.deps.fetchChatFacts = async () => { throw new Error('chat_facts failed: HTTP 500') }
    h.unread.push(row('m1', 1))
    await expect(pullAgentInbox(AGENT, h.deps)).rejects.toThrow('chat_facts failed')
    expect(h.injected).toHaveLength(0)
  })
})

describe('信封里的群规格子', () => {
  const base = { route: 'chat' as const, from: 'Ada', fromId: 'user:h', messageId: 'msg:m', at: 'now', content: 'hi' }
  it('清空通知是一个自闭合元素;原文里的 ]]> 不会截断 CDATA', () => {
    expect(renderDeliveryEnvelope({ ...base, groupRules: { version: 'none', text: '' } }))
      .toContain('<group_rules version="none" removed="true"/>')
    const text = renderDeliveryEnvelope({ ...base, groupRules: { version: 'v', text: 'a]]>b' } })
    expect(text).toContain('<![CDATA[a]]]]><![CDATA[>b]]>')
  })
})
