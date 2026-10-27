/**
 * delivery-routing S2b 判据:P-E1(游标幂等)/P-E2(after 推进窗口)/P-E4(离线追赶合并)/
 * P-E6(已读回执)/P-E7(nudge 风暴恰好一次)+ 水位停滞读数。「这条消息唤醒谁」不在这里(#6077)。
 *
 * 假云逐字段镜像真云语义(pull_agent_inbox 的过滤 + identity.mark_read_on_deliver 的
 * 精确读行/水位 gap-guard——gate 只看「中间存在他人消息」,whisper 也计入,可永久停滞,#1529B)。
 * SIGKILL 的模拟 = 内存态清空(resetAgentInboxReaderStateForTests)+ 假云原样保留:
 * 进程死掉丢的恰好就是内存,云端游标就是恢复的全部依据。
 *
 * 每条判据都带必失败对照(变异构造为显式测试用例,红以「断言变异后必然出现坏结果」的形式常驻)。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createNodeFileResolver, saveFileHandle } from '@gugu/core/local/files/fileSnapshots'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __pullOnceUnguardedForTests,
  kickAgentInboxPull,
  pullAgentInbox,
  resetAgentInboxReaderStateForTests,
  type AgentInboxFetchInput,
  type AgentInboxInjectionVerdict,
  type AgentInboxInjectionInput,
  type AgentInboxDeliveryTiming,
  type AgentInboxReaderDeps,
  type AgentInboxUnreadRow,
  unreadRowFromRpc,
  combineCoalescedPulls,
  isSaidInChat,
  agentSpokeAfterViaRpc,
  postDeliveryDisclosureRow,
} from '@gugu/core/local/agent/agentInboxReader'
import { resolveListenModeDefault } from '@gugu/core/cloud/listenMode'
import { memoryGroupRulesLedger } from '@gugu/core/local/agent/groupRulesDelivery'
import { readDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope'
import { parseSystemNotice } from '@gugu/core/shared/ui/systemNotice'
import { storedMessageLink } from '@gugu/core/shared/ui/guguLink'

const AGENT = 'agent-0000-0000-0000-000000000001'
const HUMAN = 'human-0000-0000-0000-000000000002'
const OTHER_AGENT = 'agent-0000-0000-0000-000000000003'

type CloudRow = {
  chatId: string
  id: string
  seq: number
  senderUserId: string | null
  senderType: 'human' | 'agent'
  content: string
  toUserIds?: string[] | null
  isWhisper?: boolean
  replyToSenderUserId?: string | null
  replyToMessageId?: string | null
  replyToContent?: string | null
  threadRootId?: string | null
  /** #5258:入群门比的是这一格。缺省 = 会话开张那一刻,即所有成员都在场之后。 */
  createdAt?: string
  ingestSeq?: number
  fileItemId?: string | null
  fileVersion?: number | null
  fileBlobId?: string | null
}

type Membership = { lastReadSeq: number; listenMode: string; notificationLevel: string; joinedAt: string; joinedIngestSeq: number }

/** 逐字段镜像云端两件套:pull_agent_inbox 的候选过滤 + mark_read_on_deliver 的精确读行/水位 gap-guard。
 * ❌ 不镜像「这条消息唤醒谁」(chat.message_wakes_agent):那条规则只有云端一份,这里再抄就是第三份。
 * 用例 post 进来的行都是该交给 AGENT 的;规则本身由 agentWakePredicate6077 的真库用例盯。 */
class FakeCloud {
  rows: CloudRow[] = []
  members = new Map<string, Membership>()
  chatMeta = new Map<string, { kind: 'dm' | 'group'; creatorUserId: string }>()
  readRows = new Set<string>()
  /** 假的服务端时钟:join 与 post 都从它取时刻,与真库同一个 now()。 */
  now = '2026-08-29T00:00:00.000Z'
  /** 假的全局入库序(镜像 chat.messages.ingest_seq,#6327):扫描围栏与入群门都按它判,❌ 按时钟。 */
  ingest = 0
  markReadCalls: Array<{ chatId: string; messageId: string }> = []

  addChat(chatId: string, kind: 'dm' | 'group', creatorUserId = HUMAN): void {
    this.chatMeta.set(chatId, { kind, creatorUserId })
  }

  /** #5258:入群时刻由服务端写(BEFORE INSERT 触发器),调用方给不了——所以这里也不接受它当参数。 */
  join(chatId: string, userId: string, membership: Partial<Omit<Membership, 'joinedAt' | 'joinedIngestSeq'>> = {}): void {
    this.members.set(`${chatId}:${userId}`, {
      lastReadSeq: 0,
      listenMode: 'active',
      notificationLevel: 'all',
      joinedAt: this.now,
      joinedIngestSeq: this.ingest,
      ...membership,
    })
  }

  /** 让时间往前走一格,好让「入群前/后」在测试里是两个真实不同的时刻。 */
  advanceClock(iso: string): void {
    this.now = iso
  }

  post(row: CloudRow): void {
    this.ingest += 1
    this.rows.push({ createdAt: this.now, ingestSeq: this.ingest, ...row })
  }

  watermark(chatId: string, userId: string): number {
    return this.members.get(`${chatId}:${userId}`)?.lastReadSeq ?? -1
  }

  fetchUnread = async (input: AgentInboxFetchInput): Promise<AgentInboxUnreadRow[]> => {
    const out: AgentInboxUnreadRow[] = []
    for (const row of this.rows.slice().sort((a, b) => a.chatId.localeCompare(b.chatId) || a.seq - b.seq)) {
      const membership = this.members.get(`${row.chatId}:${input.agentUserId}`)
      if (!membership) continue
      if (input.chatId && row.chatId !== input.chatId) continue
      if (row.senderUserId === input.agentUserId) continue
      if (row.seq <= Math.max(membership.lastReadSeq, input.afterSeq ?? 0)) continue
      if (input.scanAfter && (row.chatId < input.scanAfter.chatId || (row.chatId === input.scanAfter.chatId && row.seq <= input.scanAfter.seq))) continue
      // #6327 扫描围栏(镜像 pull_agent_inbox_v2 的 `m.ingest_seq <= fence`)。
      if ((row.ingestSeq ?? 0) > (input.scanFence ?? this.ingest)) continue
      // #5258 入群门(镜像 v2 的 `m.ingest_seq > cm.joined_ingest_seq`)。
      if ((row.ingestSeq ?? 0) <= membership.joinedIngestSeq) continue
      if (row.isWhisper && !(row.toUserIds ?? []).includes(input.agentUserId)) continue
      if (this.readRows.has(`${row.id}:${input.agentUserId}`)) continue
      const meta = this.chatMeta.get(row.chatId)!
      out.push({
        chatId: row.chatId,
        chatKind: meta.kind,
        chatPublicId: 42,
        chatName: `chat-${row.chatId}`,
        chatCreatorUserId: meta.creatorUserId,
        listenMode: membership.listenMode,
        notificationLevel: membership.notificationLevel,
        lastReadSeq: membership.lastReadSeq,
        id: row.id,
        seq: row.seq,
        senderUserId: row.senderUserId,
        senderType: row.senderType,
        senderDisplayName: row.senderUserId === HUMAN ? 'Ada' : 'Peer',
        senderGuguNumber: null,
        content: row.content,
        contentType: 'text',
        fileItemId: row.fileItemId ?? null,
        fileVersion: row.fileVersion ?? null,
        fileBlobId: row.fileBlobId ?? null,
        toUserIds: row.toUserIds ?? null,
        isWhisper: row.isWhisper ?? false,
        replyToMessageId: row.replyToMessageId ?? null,
        replyToSenderUserId: row.replyToSenderUserId ?? null,
        replyToContent: row.replyToContent ?? null,
        threadRootId: row.threadRootId ?? null,
        isThreadRoot: false,
        createdAt: row.createdAt ?? this.now,
        scanFence: input.scanFence ?? this.ingest,
      })
      if (out.length >= (input.limit ?? 80)) break
    }
    return out
  }

  markRead = async (input: { chatId: string; messageId: string; agentUserId: string }): Promise<void> => {
    this.markReadCalls.push({ chatId: input.chatId, messageId: input.messageId })
    const target = this.rows.find((row) => row.id === input.messageId && row.chatId === input.chatId)
    if (!target) return
    // 精确读行:无条件写(#1529B)。
    this.readRows.add(`${input.messageId}:${input.agentUserId}`)
    const key = `${input.chatId}:${input.agentUserId}`
    const membership = this.members.get(key)
    if (!membership) return
    // 水位 gate:current 与 target 之间存在**他人**消息(不看其已读,whisper 也计入)→ 不前进。
    const gap = this.rows.some((row) =>
      row.chatId === input.chatId
      && row.senderUserId !== input.agentUserId
      && row.seq > membership.lastReadSeq
      && row.seq < target.seq,
    )
    if (gap) return
    membership.lastReadSeq = Math.max(membership.lastReadSeq, target.seq)
  }
}

type Injection = Pick<AgentInboxInjectionInput, 'messageId' | 'text' | 'attachments'>

function makeDeps(
  cloud: FakeCloud,
  overrides: Partial<AgentInboxReaderDeps> = {},
): { deps: AgentInboxReaderDeps; injections: Injection[]; wakes: string[]; outcomes: Array<{ ok: boolean }> } {
  const injections: Injection[] = []
  const wakes: string[] = []
  const outcomes: Array<{ ok: boolean }> = []
  const deps: AgentInboxReaderDeps = {
    accessToken: 'owner-token',
    fetchChatFacts: async () => null,
    agentSpokeAfter: async () => false,
    groupRulesLedger: memoryGroupRulesLedger(),
    inject: async (input) => {
      injections.push({ messageId: input.messageId, text: input.text, attachments: input.attachments })
      return 'accepted' as AgentInboxInjectionVerdict
    },
    wake: (agentUserId) => { wakes.push(agentUserId) },
    fetchUnread: cloud.fetchUnread,
    markRead: cloud.markRead,
    onOutcome: (outcome) => { outcomes.push({ ok: outcome.ok }) },
    ...overrides,
  }
  return { deps, injections, wakes, outcomes }
}

/** P-E4 的段级断言:每条消息在合并输入里保有**自己**的 msg id 段(<gugu_delivery … msg="msg:<id>" …>)。 */
function assertPerMessageAttribution(text: string, ids: string[]): void {
  const segments = text.split('<gugu_delivery ').slice(1)
  if (segments.length !== ids.length) {
    throw new Error(`expected ${ids.length} envelope segments, got ${segments.length}`)
  }
  for (const id of ids) {
    const segment = segments.find((candidate) => candidate.includes(`msg="msg:${id}"`))
    if (!segment) throw new Error(`no segment carries msg:${id}`)
    for (const attr of ['route="chat"', 'from_id="user:', 'chat="', 'at="']) {
      if (!segment.includes(attr)) throw new Error(`segment msg:${id} lost its ${attr} fact`)
    }
  }
}

beforeEach(() => {
  resetAgentInboxReaderStateForTests()
})

// 「这条消息唤醒谁」不在 reader 里:那是云端 chat.message_wakes_agent 一处的事(push 与 pull 共用),
// 真值表与 push≡pull 的对账在 tests/integration/service/agentWakePredicate6077.test.ts。
// 这里只留 reader 自己的行为:RPC 交来的每一行都注入。
describe('reader 对 RPC 交来的行不做资格判断', () => {
  const base: AgentInboxUnreadRow = {
    chatId: '00000000-0000-4000-8000-000000000001', chatKind: 'group', chatPublicId: 1, chatName: 'g', chatCreatorUserId: HUMAN,
    listenMode: 'active', notificationLevel: 'all', lastReadSeq: 0,
    id: '10000000-0000-4000-8000-00000000000f', seq: 1, senderUserId: HUMAN, senderType: 'human', senderDisplayName: 'Ada',
    senderGuguNumber: null, content: 'hi', contentType: 'text', toUserIds: null, isWhisper: false,
    replyToMessageId: null, replyToSenderUserId: null, replyToContent: null,
    threadRootId: null, isThreadRoot: false, createdAt: '2026-08-29T10:00:00.000Z',
  }

  it('injects senderless system events once, under the system identity', async () => {
    const rows: AgentInboxUnreadRow[] = [
      { ...base, id: '10000000-0000-4000-8000-00000000001e', seq: 1, senderUserId: null, senderType: null, contentType: 'system', content: '已转为被动模式' },
      { ...base, id: '10000000-0000-4000-8000-000000000021', seq: 4, senderUserId: null, senderType: null, contentType: 'system', listenMode: 'passive', toUserIds: [AGENT] },
    ]
    const injected: AgentInboxInjectionInput[] = []
    const read = new Set<string>()
    const deps: AgentInboxReaderDeps = {
      accessToken: 'test',
      fetchChatFacts: async () => null,
      groupRulesLedger: memoryGroupRulesLedger(),
      fetchUnread: async () => rows.filter((row) => !read.has(row.id)),
      inject: async (input) => { injected.push(input); return 'accepted' },
      markRead: async ({ messageId }) => { read.add(messageId) },
    }
    const result = await pullAgentInbox(AGENT, deps)
    expect(result).toMatchObject({ pulled: 2, injected: 2, verdict: 'accepted' })
    expect([...read]).toEqual(['10000000-0000-4000-8000-00000000001e', '10000000-0000-4000-8000-000000000021'])
    const delivered = injected.map((input) => input.text).join('\n')
    expect(delivered).toContain('from="咕咕系统" from_id="system:gugu"')
    expect(delivered).toContain('msg="msg:10000000-0000-4000-8000-00000000001e"')
    expect(delivered).not.toContain('user:null')
    // Nudge storms and a restarted reader use the existing exact read markers.
    await Promise.all([pullAgentInbox(AGENT, deps), pullAgentInbox(AGENT, deps)])
    resetAgentInboxReaderStateForTests()
    expect((await pullAgentInbox(AGENT, deps)).injected).toBe(0)
    expect(injected).toHaveLength(2)
  })

  // @@@5856 档位收成两档之后,字符串 'adaptive' 仍然躺在老设备的本地队列、未落地的组队
  // 蓝图和历史台账里。把它判成非法 ⇒ 它走的是 #1680 那条「本应解析成功却没成功」的
  // 异常通道(dev 下喷 stderr 、e2e 的 _mainProcessGuard 会据此报红),而它并不是异常。
  // 判据只看投递结果的话没有分辨力(未知值也保守回落 active),所以这一格同时盯住
  // 「有没有报异常」;阳控是一个真的未知值 —— 它必须报。
  it('老值 adaptive 当 active 接住,且不当成解析异常报', () => {
    const prevFlag = process.env.GUGU_DEV_FAIL_LOUD
    process.env.GUGU_DEV_FAIL_LOUD = '1'
    const seen: string[] = []
    const realError = console.error
    console.error = (...args: unknown[]) => { seen.push(args.map(String).join(' ')) }
    try {
      expect(resolveListenModeDefault('adaptive')).toBe('active')
      expect(resolveListenModeDefault('default')).toBe('active')
      expect(resolveListenModeDefault(null)).toBe('active')
      expect(seen, '老值不是异常,不该走 #1680 的 fail-loud 通道').toEqual([])
      // 阳控:探针确实能产出与期待相反的结果 —— 真正的未知值仍然报。
      expect(resolveListenModeDefault('bogus-tier')).toBe('active')
      expect(seen.join('\n')).toContain('resolveListenModeDefault unknown listen_mode value')
    } finally {
      console.error = realError
      if (prevFlag === undefined) delete process.env.GUGU_DEV_FAIL_LOUD
      else process.env.GUGU_DEV_FAIL_LOUD = prevFlag
    }
  })
})

describe('P-E4 离线追赶:未读行逐条受理,由队列 drain 合批', () => {
  it.each([null, 'thread-root'])('preserves body and mention context with thread %s', async (threadRootId) => {
    const cloud = new FakeCloud()
    cloud.addChat('00000000-0000-4000-8000-00000000000c', 'dm')
    cloud.join('00000000-0000-4000-8000-00000000000c', AGENT)
    cloud.join('00000000-0000-4000-8000-00000000000c', HUMAN)
    cloud.post({
      chatId: '00000000-0000-4000-8000-00000000000c',
      id: '10000000-0000-4000-8000-000000000013',
      threadRootId,
      seq: 1,
      senderUserId: HUMAN,
      senderType: 'human',
      content: '@Codex 2 DM-MENTION-9440',
      toUserIds: [AGENT, OTHER_AGENT],
    })
    const { deps, injections } = makeDeps(cloud, {
      fetchThreadMessages: async () => [{ senderUserId: HUMAN, content: 'Earlier thread context', createdAt: '2026-09-20T10:00:00Z' }],
      resolveGuguIds: async (ids) => new Map(
        ids.filter((id): id is string => id === OTHER_AGENT).map((id) => [id, {
          guguNumber: null,
          displayName: 'Codex 2',
          isAgent: true,
        }]),
      ),
    })

    await expect(pullAgentInbox(AGENT, deps)).resolves.toMatchObject({ injected: 1, verdict: 'accepted' })
    expect(injections[0]!.text).toContain(
      '<message_context><![CDATA["@Codex 2" = user:agent-0000-0000-0000-000000000003 (agent)]]></message_context>',
    )
    expect(injections[0]!.text).toContain('<![CDATA[@Codex 2 DM-MENTION-9440]]>')
    expect(injections[0]!.text).not.toContain('scope=')
    expect(injections[0]!.text).not.toContain('send with session_message')
    expect(cloud.rows[0]!.content).toBe('@Codex 2 DM-MENTION-9440')
    if (threadRootId) expect(injections[0]!.text).toContain('<thread_context>')
  })

  // A quoted message names its sender, even when that is the receiving agent itself (its owner replying to what the agent
  // said): the transcript's delivery card shows that name, not a bare user id (gugu-dev#181).
  it('names the sender of the quoted message, the receiving agent included', async () => {
    const cloud = new FakeCloud()
    cloud.addChat('00000000-0000-4000-8000-00000000000d', 'group')
    cloud.join('00000000-0000-4000-8000-00000000000d', AGENT)
    cloud.join('00000000-0000-4000-8000-00000000000d', HUMAN)
    cloud.post({
      chatId: '00000000-0000-4000-8000-00000000000d', id: '10000000-0000-4000-8000-000000000019', seq: 1, senderUserId: HUMAN, senderType: 'human', content: '先不建', toUserIds: [AGENT],
      replyToMessageId: 'mine-1', replyToSenderUserId: AGENT, replyToContent: '要不要建 README？',
    })
    const asked: string[][] = []
    const { deps, injections } = makeDeps(cloud, {
      resolveGuguIds: async (ids) => {
        asked.push(ids.filter((id): id is string => typeof id === 'string'))
        return new Map(ids.filter((id) => id === AGENT).map((id) => [id, { guguNumber: 7, displayName: 'Claude 1', isAgent: true }]))
      },
    })

    await expect(pullAgentInbox(AGENT, deps)).resolves.toMatchObject({ injected: 1 })
    expect(asked.flat()).toContain(AGENT)
    expect(readDeliveryEnvelope(injections[0]!.text)?.segments[0]?.facts?.replyTo).toMatchObject({ fromId: `user:${AGENT}`, from: expect.stringContaining('Claude 1') })
  })

  // #6835 悄悄话:库里的 is_whisper 行到信封上就是一格 whisper_to,agent 知道这句只有它和发信人看得见。
  it('marks a whisper with whisper_to naming its recipient, and an ordinary group line with nothing', async () => {
    const cloud = new FakeCloud()
    cloud.addChat('00000000-0000-4000-8000-000000000010', 'group')
    cloud.join('00000000-0000-4000-8000-000000000010', AGENT)
    cloud.join('00000000-0000-4000-8000-000000000010', HUMAN)
    cloud.post({ chatId: '00000000-0000-4000-8000-000000000010', id: '10000000-0000-4000-8000-00000000001f', seq: 1, senderUserId: HUMAN, senderType: 'human', content: 'psst', isWhisper: true, toUserIds: [AGENT] })
    cloud.post({ chatId: '00000000-0000-4000-8000-000000000010', id: '10000000-0000-4000-8000-000000000007', seq: 2, senderUserId: HUMAN, senderType: 'human', content: 'hello all', toUserIds: [AGENT] })
    const { deps, injections } = makeDeps(cloud)

    await expect(pullAgentInbox(AGENT, deps)).resolves.toMatchObject({ injected: 2 })
    const [whisper, ordinary] = injections.map((injection) => injection.text)
    expect(whisper).toContain(`whisper_to="user:${AGENT}"`)
    expect(readDeliveryEnvelope(whisper!)?.segments[0]?.facts?.whisperTo).toBe(`user:${AGENT}`)
    expect(ordinary).not.toContain('whisper_to=')
  })

  it('tells the receiving agent that a mention of itself is itself — no route to message itself', async () => {
    const cloud = new FakeCloud()
    cloud.addChat('00000000-0000-4000-8000-00000000000e', 'group')
    cloud.join('00000000-0000-4000-8000-00000000000e', AGENT)
    cloud.join('00000000-0000-4000-8000-00000000000e', HUMAN)
    cloud.post({
      chatId: '00000000-0000-4000-8000-00000000000e',
      id: '10000000-0000-4000-8000-00000000001a',
      seq: 1,
      senderUserId: HUMAN,
      senderType: 'human',
      content: '@Codex 7 tell Codex 6 your lucky number',
      toUserIds: [AGENT],
    })
    const { deps, injections } = makeDeps(cloud, {
      resolveGuguIds: async (ids) => new Map(
        ids.filter((id): id is string => id === AGENT).map((id) => [id, {
          guguNumber: null,
          displayName: 'Codex 7',
          isAgent: true,
        }]),
      ),
    })

    await expect(pullAgentInbox(AGENT, deps)).resolves.toMatchObject({ injected: 1, verdict: 'accepted' })
    expect(injections[0]!.text).toContain(`"@Codex 7" = user:${AGENT} (agent, you)`)
    expect(injections[0]!.text).toContain('<![CDATA[@Codex 7 tell Codex 6 your lucky number]]>')
    expect(injections[0]!.text).not.toContain(`session_message to=user:${AGENT}`)
  })

  it('session-direct rows enter the same reader one by one', async () => {
    const cloud = new FakeCloud()
    const localRows: AgentInboxUnreadRow[] = [1, 2, 3].map((seq) => ({
      chatId: 'local-session:conversation-1',
      chatKind: 'dm',
      chatPublicId: null,
      chatName: null,
      chatCreatorUserId: null,
      listenMode: 'active',
      notificationLevel: 'all',
      lastReadSeq: 0,
      id: `direct-${seq}`,
      seq,
      senderUserId: AGENT,
      senderType: 'agent',
      senderDisplayName: null,
      senderGuguNumber: null,
      content: '',
      contentType: 'text',
      toUserIds: [AGENT],
      isWhisper: true,
      replyToMessageId: null,
      replyToSenderUserId: null,
      replyToContent: null,
      threadRootId: null,
      isThreadRoot: false,
      createdAt: '2026-08-29T10:00:00.000Z',
      localSessionDirect: {
        sessionId: 'conversation-1',
        envelope: `<gugu_delivery route="session-direct" msg="msg:direct-${seq}"><![CDATA[direct-${seq}]]></gugu_delivery>`,
      },
    }))
    const batches: Array<{ agentUserId: string; rows: number; units: number }> = []
    const read: string[] = []
    const { deps, injections } = makeDeps(cloud, {
      fetchLocalUnread: async () => localRows.filter((row) => !read.includes(row.id)),
      markLocalRead: async ({ messageId }) => { read.push(messageId) },
      onBatch: (batch) => batches.push(batch),
    })

    const result = await pullAgentInbox(AGENT, deps)

    expect(result).toMatchObject({ pulled: 3, injected: 3, verdict: 'accepted' })
    expect(injections).toHaveLength(3)
    expect(batches).toEqual([{ agentUserId: AGENT, rows: 3, units: 3 }])
    expect(injections.map((entry) => entry.messageId)).toEqual(['direct-1', 'direct-2', 'direct-3'])
    expect(injections.every((entry) => entry.text.includes('<gugu_delivery route="session-direct"'))).toBe(true)
    expect(read).toEqual(['direct-1', 'direct-2', 'direct-3'])
  })

  it('本机 pending 删除后位置重编号仍会再次投递,不受云端 overlay 影响', async () => {
    const cloud = new FakeCloud()
    let pending = ['direct-first']
    const localRows = async (): Promise<AgentInboxUnreadRow[]> => pending.map((id, index) => ({
      chatId: 'local-session:conversation-1',
      chatKind: 'dm',
      chatPublicId: null,
      chatName: null,
      chatCreatorUserId: null,
      listenMode: 'active',
      notificationLevel: 'all',
      lastReadSeq: 0,
      id,
      seq: index + 1,
      senderUserId: AGENT,
      senderType: 'agent',
      senderDisplayName: null,
      senderGuguNumber: null,
      content: '',
      contentType: 'text',
      toUserIds: [AGENT],
      isWhisper: true,
      replyToMessageId: null,
      replyToSenderUserId: null,
      replyToContent: null,
      threadRootId: null,
      isThreadRoot: false,
      createdAt: '2026-08-29T10:00:00.000Z',
      localSessionDirect: {
        sessionId: 'conversation-1',
        envelope: `<gugu_delivery route="session-direct" msg="msg:${id}"><![CDATA[${id}]]></gugu_delivery>`,
      },
    }))
    const read: string[] = []
    const { deps, injections } = makeDeps(cloud, {
      fetchLocalUnread: async () => (await localRows()).filter((row) => !read.includes(row.id)),
      markLocalRead: async ({ messageId }) => {
        read.push(messageId)
        pending = pending.filter((id) => id !== messageId)
      },
    })

    await pullAgentInbox(AGENT, deps)
    pending.push('direct-second')
    await pullAgentInbox(AGENT, deps)

    expect(injections.map((entry) => entry.messageId)).toEqual(['direct-first', 'direct-second'])
    expect(read).toEqual(['direct-first', 'direct-second'])
  })

  it('本机注入失败时不删除 pending,后续触发仍可重试', async () => {
    const cloud = new FakeCloud()
    const row: AgentInboxUnreadRow = {
      chatId: 'local-session:conversation-1', chatKind: 'dm', chatPublicId: null, chatName: null,
      chatCreatorUserId: null, listenMode: 'active', notificationLevel: 'all', lastReadSeq: 0,
      id: 'direct-failed', seq: 1, senderUserId: AGENT, senderType: 'agent', senderDisplayName: null,
      senderGuguNumber: null, content: '', contentType: 'text', toUserIds: [AGENT], isWhisper: true,
      replyToMessageId: null, replyToSenderUserId: null, replyToContent: null, threadRootId: null,
      isThreadRoot: false, createdAt: '2026-08-29T10:00:00.000Z',
      localSessionDirect: {
        sessionId: 'conversation-1',
        envelope: '<gugu_delivery route="session-direct" msg="msg:direct-failed"><![CDATA[failed]]></gugu_delivery>',
      },
    }
    let failed = true
    let deleted = false
    const { deps, injections } = makeDeps(cloud, {
      fetchLocalUnread: async () => (deleted ? [] : [row]),
      inject: async (input) => {
        injections.push({ messageId: input.messageId, text: input.text })
        if (failed) {
          failed = false
          throw new Error('provider unavailable')
        }
        return 'accepted'
      },
      markLocalRead: async () => { deleted = true },
      postDisclosure: async () => {},
    })

    await expect(pullAgentInbox(AGENT, deps)).rejects.toThrow('provider unavailable')
    expect(deleted).toBe(false)
    await pullAgentInbox(AGENT, deps)
    expect(deleted).toBe(true)
    expect(injections.map((entry) => entry.messageId)).toEqual(['direct-failed', 'direct-failed'])
  })

  it('跨 ≥2 chat 的积压逐条 admission,游标推进到各 chat 的 max(seq)', async () => {
    const cloud = new FakeCloud()
    for (const chat of ['00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000006']) {
      cloud.addChat(chat, 'group')
      cloud.join(chat, AGENT, { listenMode: 'active' })
      cloud.join(chat, HUMAN)
    }
    cloud.post({ chatId: '00000000-0000-4000-8000-000000000003', id: '10000000-0000-4000-8000-00000000000f', seq: 1, senderUserId: HUMAN, senderType: 'human', content: 'one' })
    cloud.post({ chatId: '00000000-0000-4000-8000-000000000003', id: '10000000-0000-4000-8000-000000000010', seq: 2, senderUserId: HUMAN, senderType: 'human', content: 'two' })
    cloud.post({ chatId: '00000000-0000-4000-8000-000000000006', id: '10000000-0000-4000-8000-000000000011', seq: 1, senderUserId: HUMAN, senderType: 'human', content: 'three' })
    const batches: Array<{ agentUserId: string; rows: number; units: number }> = []
    const { deps, injections } = makeDeps(cloud, { onBatch: (batch) => batches.push(batch) })

    const result = await pullAgentInbox(AGENT, deps)

    expect(result).toMatchObject({ injected: 3, verdict: 'accepted' })
    expect(injections).toHaveLength(3)
    expect(batches).toEqual([{ agentUserId: AGENT, rows: 3, units: 3 }])
    for (const injection of injections) {
      expect(injection.text).toContain('<gugu_delivery route="chat"')
    }
    expect(cloud.watermark('00000000-0000-4000-8000-000000000003', AGENT)).toBe(2)
    expect(cloud.watermark('00000000-0000-4000-8000-000000000006', AGENT)).toBe(1)

    // 追赶完成后再拉 = idle,零注入。
    const second = await pullAgentInbox(AGENT, deps)
    expect(second).toMatchObject({ injected: 0, verdict: 'idle' })
    expect(injections).toHaveLength(3)
  })

  it('inbox entries are admitted one by one while attachments remain solo', async () => {
    const cloud = new FakeCloud()
    cloud.addChat('00000000-0000-4000-8000-000000000005', 'group')
    cloud.join('00000000-0000-4000-8000-000000000005', AGENT, { listenMode: 'active' })
    cloud.join('00000000-0000-4000-8000-000000000005', HUMAN)
    cloud.post({ chatId: '00000000-0000-4000-8000-000000000005', id: '10000000-0000-4000-8000-000000000017', seq: 1, senderUserId: HUMAN, senderType: 'human', content: '10000000-0000-4000-8000-000000000017' })
    cloud.post({
      chatId: '00000000-0000-4000-8000-000000000005', id: '10000000-0000-4000-8000-000000000008', seq: 2, senderUserId: HUMAN, senderType: 'human',
      content: '[附件] one.png (image/png)\n[URL] https://example.test/one.png\n[Size] 3\n[Kind] image',
    })
    cloud.post({ chatId: '00000000-0000-4000-8000-000000000005', id: '10000000-0000-4000-8000-000000000018', seq: 3, senderUserId: HUMAN, senderType: 'human', content: '10000000-0000-4000-8000-000000000018' })
    const batches: Array<{ agentUserId: string; rows: number; units: number }> = []
    const { deps, injections } = makeDeps(cloud, {
      onBatch: (batch) => batches.push(batch),
      downloadAttachment: async () => ({ bytes: Uint8Array.from([1, 2]), localPath: '/tmp/one.png' }),
    })

    await expect(pullAgentInbox(AGENT, deps)).resolves.toMatchObject({ pulled: 3, injected: 3, verdict: 'accepted' })
    expect(batches).toEqual([{ agentUserId: AGENT, rows: 3, units: 3 }])
    expect(injections.map((entry) => entry.messageId)).toEqual(['10000000-0000-4000-8000-000000000017', '10000000-0000-4000-8000-000000000008', '10000000-0000-4000-8000-000000000018'])
    expect(injections.map((entry) => entry.attachments?.length ?? 0)).toEqual([0, 1, 0])
    expect(injections.every((entry) => entry.text.includes('<gugu_delivery route="chat"'))).toBe(true)
  })

  // #7290 新式附件:正文没有 [URL],字节由行上的 file_item_id / file_version 指着;条目删了就只交正文。
  it('folder-backed image: downloads by its file pointer; a deleted file delivers the text without bytes', async () => {
    const cloud = new FakeCloud()
    cloud.addChat('00000000-0000-4000-8000-000000000009', 'group')
    cloud.join('00000000-0000-4000-8000-000000000009', AGENT, { listenMode: 'active' })
    cloud.join('00000000-0000-4000-8000-000000000009', HUMAN)
    const envelope = '[附件] two.png (image/png)\n[Size] 3\n[Kind] image'
    cloud.post({ chatId: '00000000-0000-4000-8000-000000000009', id: '10000000-0000-4000-8000-00000000000b', seq: 1, senderUserId: HUMAN, senderType: 'human', content: envelope, fileItemId: 'item-2', fileVersion: 4 })
    cloud.post({ chatId: '00000000-0000-4000-8000-000000000009', id: '10000000-0000-4000-8000-00000000000a', seq: 2, senderUserId: HUMAN, senderType: 'human', content: envelope, fileItemId: null, fileVersion: 4 })
    // 悄悄话的附件:不进群文件夹,消息直接指字节 ⇒ 按这条消息签(能读这条消息的人才签得到)。
    cloud.post({ chatId: '00000000-0000-4000-8000-000000000009', id: '10000000-0000-4000-8000-00000000000c', seq: 3, senderUserId: HUMAN, senderType: 'human', content: envelope, fileBlobId: 'blob-9' })
    const asked: unknown[] = []
    const { deps, injections } = makeDeps(cloud, {
      downloadAttachment: async (source) => {
        asked.push(source)
        return { bytes: Uint8Array.from([1, 2]), localPath: '/tmp/two.png' }
      },
    })
    await expect(pullAgentInbox(AGENT, deps)).resolves.toMatchObject({ pulled: 3, injected: 3 })
    expect(asked).toEqual([{ message_id: '10000000-0000-4000-8000-00000000000b' }, { message_id: '10000000-0000-4000-8000-00000000000c' }])
    expect(injections.map((entry) => entry.attachments?.length ?? 0)).toEqual([1, 0, 1])
    expect(injections[1]!.text).toContain('[附件] two.png (image/png)')
    expect(injections[0]!.text).toContain('[Folder file gugu-file://item-2?v=4')
    expect(injections[2]!.text, '悄悄话附件不在文件夹里').not.toContain('[Folder file')
  })

  // 新式附件的文件(不是图,比如 App 包):正文里没有链接,字节和图片一样下到本机、正文后面交本地路径;
  // Legacy pointers use the same signed resolver; without verified private metadata they fail closed. Deleted items stay text-only.
  it('saves the current file, refuses an unverified legacy pointer without fetching its public URL, and keeps deleted files text-only', async () => {
    const cloud = new FakeCloud()
    cloud.addChat('00000000-0000-4000-8000-000000000008', 'group')
    cloud.join('00000000-0000-4000-8000-000000000008', AGENT, { listenMode: 'active' })
    cloud.join('00000000-0000-4000-8000-000000000008', HUMAN)
    const pkg = '[附件] poll-0.1.0.guguext (application/vnd.gugu.extension+zip)\n[Size] 1200\n[Kind] file'
    cloud.post({ chatId: '00000000-0000-4000-8000-000000000008', id: '10000000-0000-4000-8000-000000000005', seq: 1, senderUserId: HUMAN, senderType: 'human', content: pkg, fileItemId: 'item-7', fileVersion: 1 })
    cloud.post({ chatId: '00000000-0000-4000-8000-000000000008', id: '10000000-0000-4000-8000-000000000006', seq: 2, senderUserId: HUMAN, senderType: 'human', content: '[附件] a.pdf (application/pdf)\n[URL] https://example.test/a.pdf\n[Size] 3\n[Kind] file' })
    cloud.post({ chatId: '00000000-0000-4000-8000-000000000008', id: '10000000-0000-4000-8000-000000000004', seq: 3, senderUserId: HUMAN, senderType: 'human', content: pkg, fileItemId: null, fileVersion: 1 })
    const asked: unknown[] = []
    const { deps, injections } = makeDeps(cloud, {
      downloadAttachment: async (source) => {
        asked.push(source)
        if ('message_id' in source && source.message_id === '10000000-0000-4000-8000-000000000006') throw new Error('Legacy file requires verified private metadata')
        return { bytes: Uint8Array.from([1, 2]), localPath: '/tmp/gugu-home/chat-media/abc-poll-0.1.0.guguext' }
      },
    })
    await expect(pullAgentInbox(AGENT, deps)).resolves.toMatchObject({ pulled: 3 })
    expect(asked).toEqual([{ message_id: '10000000-0000-4000-8000-000000000005' }, { message_id: '10000000-0000-4000-8000-000000000006' }])
    const text = injections.map((entry) => entry.text).join('\n')
    expect(text).toContain('[附件] poll-0.1.0.guguext (application/vnd.gugu.extension+zip)')
    expect(text).toContain('[File saved at local path: /tmp/gugu-home/chat-media/abc-poll-0.1.0.guguext]')
    expect(text.match(/\[File saved at local path:/g)).toHaveLength(1)
    // 它是群文件夹里的哪个文件、哪一版,怎么再发、怎么把改过的发成下一版:只在指着条目的那一条上。
    expect(text).toContain('[Folder file gugu-file://item-7?v=1 — show it again: message_send_file {file: "gugu-file://item-7?v=1"}')
    expect(text.match(/\[Folder file /g)).toHaveLength(1)
    expect(text).toContain('[URL] https://example.test/a.pdf')
    expect(text).toContain('[File not saved: Legacy file requires verified private metadata]')
    expect(injections.every((entry) => !entry.attachments)).toBe(true)
  })

  // 文件下不下来(签不到、CDN 回错、超时):这一行照交、照实说没存下,同一批的别的行也照样送到 —— 收件不卡在这一行上。
  it('a file that cannot be saved: its text goes with the reason, and the other rows of the batch are delivered too', async () => {
    const cloud = new FakeCloud()
    cloud.addChat('00000000-0000-4000-8000-000000000007', 'group')
    cloud.join('00000000-0000-4000-8000-000000000007', AGENT, { listenMode: 'active' })
    cloud.join('00000000-0000-4000-8000-000000000007', HUMAN)
    cloud.post({ chatId: '00000000-0000-4000-8000-000000000007', id: '10000000-0000-4000-8000-000000000002', seq: 1, senderUserId: HUMAN, senderType: 'human', content: 'before the file' })
    cloud.post({ chatId: '00000000-0000-4000-8000-000000000007', id: '10000000-0000-4000-8000-000000000003', seq: 2, senderUserId: HUMAN, senderType: 'human', content: '[附件] deck.pptx (application/vnd.openxmlformats-officedocument.presentationml.presentation)\n[Size] 9\n[Kind] file', fileItemId: 'item-9', fileVersion: 2 })
    cloud.post({ chatId: '00000000-0000-4000-8000-000000000007', id: '10000000-0000-4000-8000-000000000001', seq: 3, senderUserId: HUMAN, senderType: 'human', content: 'after the file' })
    const { deps, injections } = makeDeps(cloud, {
      downloadAttachment: async () => { throw new Error('chat attachment download failed (503)') },
    })
    await expect(pullAgentInbox(AGENT, deps)).resolves.toMatchObject({ pulled: 3 })
    const text = injections.map((entry) => entry.text).join('\n')
    expect(text).toContain('before the file')
    expect(text).toContain('[附件] deck.pptx')
    expect(text).toContain('[File not saved: chat attachment download failed (503)]')
    expect(text).toContain('after the file')
  })

  // #7290 复核 X2:签链接以 agent 自己的身份(`as` = agent),不是令牌的主人 —— 主人读得到的,agent 不一定读得到。
  it('exports the verified image through the canonical resolver as this inbox agent, never its owner', async () => {
    vi.stubEnv('GUGU_SUPABASE_URL', 'https://db.example.test')
    vi.stubEnv('GUGU_SUPABASE_ANON_KEY', 'anon')
    const home = mkdtempSync(join(tmpdir(), 'gugu-inbox-as-agent-'))
    const asked: Array<{ url: string; body: unknown }> = []
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      asked.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null })
      const revision = { status: 'ready', source: 'managed-object', file_name: 'two.png', content_type: 'image/png', sha256: createHash('sha256').update(new Uint8Array([1, 2, 3])).digest('hex'), size_bytes: 3 }
      if (url.endsWith('/file-resolve')) return Response.json(revision)
      if (url.endsWith('/file-download')) return Response.json({ ...revision, download_id: 'download', url: 'https://cdn.example.test/two.png?auth_key=1' })
      return new Response(new Uint8Array([1, 2, 3]))
    })
    try {
      const cloud = new FakeCloud()
      cloud.addChat('00000000-0000-4000-8000-000000000004', 'group')
      cloud.join('00000000-0000-4000-8000-000000000004', AGENT, { listenMode: 'active' })
      cloud.join('00000000-0000-4000-8000-000000000004', HUMAN)
      cloud.post({ chatId: '00000000-0000-4000-8000-000000000004', id: '10000000-0000-4000-8000-000000000009', seq: 1, senderUserId: HUMAN, senderType: 'human', content: '[附件] two.png (image/png)\n[Size] 3\n[Kind] image', fileItemId: 'item-2', fileVersion: 4 })
      const resolve = createNodeFileResolver(join(home, 'cache'), async () => ({ supabaseUrl: 'https://db.example.test', anonKey: 'anon', token: 'owner-token' }))
      const { deps, injections } = makeDeps(cloud, { env: { GUGU_HOME: home }, downloadAttachment: async (ref, name, actorId) => {
        const file = await resolve(ref, { accountId: HUMAN, actorId })
        if (file.status !== 'ready') throw Error('Expected image')
        const saved = await saveFileHandle(file, join(home, 'chat-media'), name)
        return { bytes: await readFile(saved.file_path), localPath: saved.file_path }
      } })
      await expect(pullAgentInbox(AGENT, deps)).resolves.toMatchObject({ pulled: 1, injected: 1 })
      expect(asked.map((one) => one.url)).toEqual(['https://db.example.test/functions/v1/attachments/file-resolve', 'https://db.example.test/functions/v1/attachments/file-download', 'https://cdn.example.test/two.png?auth_key=1', 'https://db.example.test/functions/v1/attachments/file-resolve'])
      expect(asked[0]!.body).toEqual({ ref: { message_id: '10000000-0000-4000-8000-000000000009' }, as: AGENT })
      expect(asked[1]!.body).toMatchObject({ ref: { message_id: '10000000-0000-4000-8000-000000000009' }, as: AGENT, request_id: expect.any(String) })
      expect(asked[3]!.body).toEqual(asked[0]!.body)
      expect(injections[0]!.attachments).toHaveLength(1)
    } finally {
      vi.unstubAllGlobals()
      vi.unstubAllEnvs()
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('a pull_agent_inbox_v2 row without file_item_id / file_version / file_blob_id is refused (the database is older than this client)', () => {
    const row = { chat_id: 'c', id: '10000000-0000-4000-8000-00000000000e', seq: 1, content: 'x', created_at: '2026-10-16T00:00:00Z' }
    expect(() => unreadRowFromRpc(row)).toThrow('no file_item_id / file_version / file_blob_id')
    expect(() => unreadRowFromRpc({ ...row, file_item_id: null, file_version: null })).toThrow('database is older than this client')
    expect(unreadRowFromRpc({ ...row, file_item_id: 'item-1', file_version: 2, file_blob_id: null })).toMatchObject({ fileItemId: 'item-1', fileVersion: 2, fileBlobId: null })
    expect(unreadRowFromRpc({ ...row, file_item_id: null, file_version: null, file_blob_id: 'blob-1' })).toMatchObject({ fileItemId: null, fileVersion: null, fileBlobId: 'blob-1' })
  })

  it('next-tool-call rows merge at steer admission while idle-only rows stay per-entry', async () => {
    const cloud = new FakeCloud()
    cloud.addChat('00000000-0000-4000-8000-00000000000f', 'group')
    cloud.join('00000000-0000-4000-8000-00000000000f', AGENT, { listenMode: 'active' })
    cloud.join('00000000-0000-4000-8000-00000000000f', HUMAN)
    for (const [id, seq] of [['10000000-0000-4000-8000-00000000001b', 1], ['10000000-0000-4000-8000-00000000001c', 2], ['10000000-0000-4000-8000-00000000001d', 3]] as const) {
      cloud.post({ chatId: '00000000-0000-4000-8000-00000000000f', id, seq, senderUserId: HUMAN, senderType: 'human', content: id })
    }
    const batches: Array<{ agentUserId: string; rows: number; units: number }> = []
    const { deps, injections } = makeDeps(cloud, {
      onBatch: (batch) => batches.push(batch),
      deliveryTiming: async (): Promise<AgentInboxDeliveryTiming> => 'next-tool-call',
    })

    await expect(pullAgentInbox(AGENT, deps)).resolves.toMatchObject({ pulled: 3, injected: 3, verdict: 'accepted' })
    expect(batches).toEqual([{ agentUserId: AGENT, rows: 3, units: 1 }])
    expect(injections).toHaveLength(1)
    expect(injections[0]!.text).toContain('<gugu_deliveries count="3"')
    for (const id of ['10000000-0000-4000-8000-00000000001b', '10000000-0000-4000-8000-00000000001c', '10000000-0000-4000-8000-00000000001d']) expect(injections[0]!.text).toContain(`msg="msg:${id}"`)
  })

  it('必失败对照:段级断言能判假 —— 吞掉一段/抹掉一格都必须红', () => {
    const cloud = new FakeCloud()
    void cloud
    const goodSegment = '<gugu_delivery route="chat" from_id="user:x" chat="42" msg="msg:10000000-0000-4000-8000-00000000000f" at="t"><![CDATA[hi]]></gugu_delivery>'
    expect(() => assertPerMessageAttribution(`<gugu_deliveries count="2">\n${goodSegment}\n</gugu_deliveries>`, ['10000000-0000-4000-8000-00000000000f', '10000000-0000-4000-8000-000000000010']))
      .toThrow(/expected 2 envelope segments/)
    const stripped = goodSegment.replace('from_id="user:x" ', '')
    expect(() => assertPerMessageAttribution(`<gugu_deliveries count="1">\n${stripped}\n</gugu_deliveries>`, ['10000000-0000-4000-8000-00000000000f']))
      .toThrow(/lost its from_id/)
  })
})

describe('入群门:agent 只收在场之后的消息(#5258)', () => {
  /** 一个已经聊过三条的群,agent 之后才被加进来。 */
  const groupWithHistory = (cloud: FakeCloud, chatId: string): void => {
    cloud.addChat(chatId, 'group')
    cloud.join(chatId, HUMAN)
    for (const seq of [1, 2, 3]) {
      cloud.post({ chatId, id: `20000000-0000-4000-8000-${String(seq).padStart(12, '0')}`, seq, senderUserId: HUMAN, senderType: 'human', content: `history ${seq}` })
    }
    cloud.advanceClock('2026-08-29T12:00:00.000Z')
    cloud.join(chatId, AGENT, { listenMode: 'active' })
  }

  it('入群前的三条一条都不推,入群后的照常投递', async () => {
    const cloud = new FakeCloud()
    groupWithHistory(cloud, '00000000-0000-4000-8000-00000000000b')
    const { deps, injections } = makeDeps(cloud)

    await expect(pullAgentInbox(AGENT, deps)).resolves.toMatchObject({ pulled: 0, injected: 0, verdict: 'idle' })
    expect(injections).toEqual([])

    cloud.post({ chatId: '00000000-0000-4000-8000-00000000000b', id: '10000000-0000-4000-8000-000000000014', seq: 4, senderUserId: HUMAN, senderType: 'human', content: 'so, what do you think?' })
    await expect(pullAgentInbox(AGENT, deps)).resolves.toMatchObject({ injected: 1, verdict: 'accepted' })
    expect(injections.map((entry) => entry.messageId)).toEqual(['10000000-0000-4000-8000-000000000014'])
    expect(injections[0]!.text).not.toContain('history 1')
  })

  it('入群前的消息不被算成「已读」:游标停在 0,已读只由真投递挣来', async () => {
    const cloud = new FakeCloud()
    groupWithHistory(cloud, '00000000-0000-4000-8000-00000000000b')
    const { deps } = makeDeps(cloud)

    // 水位是人的聊天页判「agent 已读」的依据之一(deriveReadReceipt 以 水位 ≥ seq 判已读),
    // 所以它 ❌ 不能因为入群就跳到 head —— 那会让故意不投递的三条在人眼里变成 agent 已读。
    await pullAgentInbox(AGENT, deps)
    expect(cloud.watermark('00000000-0000-4000-8000-00000000000b', AGENT)).toBe(0)
    expect([...cloud.readRows]).toEqual([])

    cloud.post({ chatId: '00000000-0000-4000-8000-00000000000b', id: '10000000-0000-4000-8000-000000000014', seq: 4, senderUserId: HUMAN, senderType: 'human', content: 'four' })
    await pullAgentInbox(AGENT, deps)
    // 投递过的那一条有精确读行(人看得到「agent 读了这条」);没投递过的三条一条都没有。
    expect([...cloud.readRows]).toEqual([`10000000-0000-4000-8000-000000000014:${AGENT}`])
  })

  it('创群就在场的 agent 不受影响:开张后的每一条都收', async () => {
    const cloud = new FakeCloud()
    cloud.addChat('00000000-0000-4000-8000-00000000000a', 'group')
    cloud.join('00000000-0000-4000-8000-00000000000a', AGENT, { listenMode: 'active' })
    cloud.join('00000000-0000-4000-8000-00000000000a', HUMAN)
    cloud.post({ chatId: '00000000-0000-4000-8000-00000000000a', id: '10000000-0000-4000-8000-00000000000f', seq: 1, senderUserId: HUMAN, senderType: 'human', content: 'hello' })
    const { deps, injections } = makeDeps(cloud)
    await expect(pullAgentInbox(AGENT, deps)).resolves.toMatchObject({ injected: 1 })
    expect(injections.map((entry) => entry.messageId)).toEqual(['10000000-0000-4000-8000-00000000000f'])
  })

  it('必失败对照(变异=摘掉入群门):入群前三条全被推出去,必须红', async () => {
    const cloud = new FakeCloud()
    groupWithHistory(cloud, '00000000-0000-4000-8000-00000000000b')
    // 变异只动被测的那一格:把 agent 的入群位置挪回第一条入库之前,门就等于不存在。
    // (门按入库序判,#6327 —— 挪 joinedAt 已经挪不动它。)
    cloud.members.get(`00000000-0000-4000-8000-00000000000b:${AGENT}`)!.joinedIngestSeq = 0
    const { deps, injections } = makeDeps(cloud)
    await expect(pullAgentInbox(AGENT, deps)).resolves.toMatchObject({ injected: 3 })
    expect(injections.map((entry) => entry.messageId)).toEqual(['20000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000003'])
  })
})

describe('P-E1 游标幂等:崩溃重启重拉,恰好一次注入', () => {
  function seed(): FakeCloud {
    const cloud = new FakeCloud()
    cloud.addChat('00000000-0000-4000-8000-000000000003', 'group')
    cloud.join('00000000-0000-4000-8000-000000000003', AGENT, { listenMode: 'active' })
    cloud.join('00000000-0000-4000-8000-000000000003', HUMAN)
    cloud.post({ chatId: '00000000-0000-4000-8000-000000000003', id: '10000000-0000-4000-8000-00000000000f', seq: 1, senderUserId: HUMAN, senderType: 'human', content: 'once' })
    return cloud
  }

  it('拉取本身无副作用:注入前死掉的 pull 不留任何痕迹,重启后恰好一次注入、游标恰好推进一次', async () => {
    const cloud = seed()
    // 「注入前 SIGKILL」:第一次 pull 只完成了 fetch(fetch 无副作用),进程死。
    await cloud.fetchUnread({ agentUserId: AGENT })
    expect(cloud.markReadCalls).toEqual([])
    // 重启(内存清空)→ 重拉。
    resetAgentInboxReaderStateForTests()
    const { deps, injections } = makeDeps(cloud)
    await pullAgentInbox(AGENT, deps)
    await pullAgentInbox(AGENT, deps)
    expect(injections).toHaveLength(1)
    expect(cloud.markReadCalls).toHaveLength(1)
    expect(cloud.watermark('00000000-0000-4000-8000-000000000003', AGENT)).toBe(1)
  })

  it('必失败对照(变异=游标读缓存):重拉不经真游标 ⇒ 重复注入,必须红', async () => {
    const cloud = seed()
    const cached = await cloud.fetchUnread({ agentUserId: AGENT })
    const { deps, injections } = makeDeps(cloud, {
      // 变异:fetch 无视云端游标,永远返回首次快照。
      fetchUnread: async () => structuredClone(cached),
    })
    await pullAgentInbox(AGENT, deps)
    resetAgentInboxReaderStateForTests()
    await pullAgentInbox(AGENT, deps)
    // 红:同一条稳定 id 被注入了两次 —— 这正是「重拉去重改坏」时判据要抓住的坏结果。
    expect(injections.map((entry) => entry.messageId)).toEqual(['10000000-0000-4000-8000-00000000000f', '10000000-0000-4000-8000-00000000000f'])
  })
})

describe('批失败披露与本机投影行(#4896 overdue 那一格)', () => {
  it('本机 session-direct 投影行注入抛出时不向云端 POST 披露(它没有 chat 行;可见面是 outbox 收据),失败仍原样上抛', async () => {
    const cloud = new FakeCloud()
    const localRow: AgentInboxUnreadRow = {
      chatId: 'local-session:conversation-1',
      chatKind: 'dm',
      chatPublicId: null,
      chatName: null,
      chatCreatorUserId: null,
      listenMode: 'active',
      notificationLevel: 'all',
      lastReadSeq: 0,
      id: 'direct-overdue',
      seq: 1,
      senderUserId: AGENT,
      senderType: 'agent',
      senderDisplayName: null,
      senderGuguNumber: null,
      content: '',
      contentType: 'text',
      toUserIds: [AGENT],
      isWhisper: true,
      replyToMessageId: null,
      replyToSenderUserId: null,
      replyToContent: null,
      threadRootId: null,
      isThreadRoot: false,
      createdAt: '2026-09-05T09:00:00.000Z',
      localSessionDirect: {
        sessionId: 'conversation-1',
        envelope: '<gugu_delivery route="session-direct" msg="msg:direct-overdue"><![CDATA[direct-overdue]]></gugu_delivery>',
      },
    }
    const disclosures: string[] = []
    const { deps } = makeDeps(cloud, {
      fetchLocalUnread: async () => [localRow],
      inject: async () => { throw Object.assign(new Error('gugu MCP 在预算内没有就绪'), { deliveryRejectedBeforeAdmission: true }) },
      postDisclosure: async (input) => { disclosures.push(input.chatId) },
    })
    await expect(pullAgentInbox(AGENT, deps)).rejects.toThrow('gugu MCP 在预算内没有就绪')
    expect(disclosures).toEqual([])
  })
})

describe('P-E2 推进时机窗口(只落已裁决的 after 支)', () => {
  it('崩在注入与推进之间:消息不丢,重复以同一稳定 id 显形', async () => {
    const cloud = new FakeCloud()
    cloud.addChat('00000000-0000-4000-8000-000000000003', 'group')
    cloud.join('00000000-0000-4000-8000-000000000003', AGENT, { listenMode: 'active' })
    cloud.join('00000000-0000-4000-8000-000000000003', HUMAN)
    cloud.post({ chatId: '00000000-0000-4000-8000-000000000003', id: '10000000-0000-4000-8000-00000000000f', seq: 1, senderUserId: HUMAN, senderType: 'human', content: 'window' })
    // 第一轮:注入受理后、游标推进前进程死(markRead 永远没跑到 —— 模拟为抛 SimulatedKill,
    // advanceCursor 收到即停,云端游标保持原位)。
    const kill = new Error('SIGKILL between inject and advance')
    const disclosures: Array<{ chatId: string; key: string; reason: string }> = []
    const { deps: crashDeps, injections: firstInjections, outcomes } = makeDeps(cloud, {
      markRead: async () => { throw kill },
      postDisclosure: async (input) => { disclosures.push({ chatId: input.chatId, key: input.key, reason: input.reason }) },
    })
    await expect(pullAgentInbox(AGENT, crashDeps)).rejects.toThrow('SIGKILL between inject and advance')
    expect(firstInjections).toHaveLength(1)
    expect(cloud.watermark('00000000-0000-4000-8000-000000000003', AGENT)).toBe(0)
    expect(disclosures).toHaveLength(1)
    expect(disclosures[0]!.key).toMatch(/^turn-failure:batch:[0-9a-f]{32}$/)
    expect(outcomes).toEqual([{ ok: false }])
    // 重启 → 重拉 → 重注入:同一稳定 id 第二次出现(重是显形的),消息没有丢。
    resetAgentInboxReaderStateForTests()
    const { deps, injections } = makeDeps(cloud)
    await pullAgentInbox(AGENT, deps)
    expect(injections.map((entry) => entry.messageId)).toEqual(['10000000-0000-4000-8000-00000000000f'])
    expect([...firstInjections, ...injections].map((entry) => entry.messageId)).toEqual(['10000000-0000-4000-8000-00000000000f', '10000000-0000-4000-8000-00000000000f'])
    expect(cloud.watermark('00000000-0000-4000-8000-000000000003', AGENT)).toBe(1)
  })

  it('必失败对照(变异=推进挪到注入前):同一时序下消息静默丢失,必须红', async () => {
    const cloud = new FakeCloud()
    cloud.addChat('00000000-0000-4000-8000-000000000003', 'group')
    cloud.join('00000000-0000-4000-8000-000000000003', AGENT, { listenMode: 'active' })
    cloud.join('00000000-0000-4000-8000-000000000003', HUMAN)
    cloud.post({ chatId: '00000000-0000-4000-8000-000000000003', id: '10000000-0000-4000-8000-00000000000f', seq: 1, senderUserId: HUMAN, senderType: 'human', content: 'lost?' })
    // 变异体:先推游标、后注入;注入点崩溃。
    const mutantAdvanceFirst = async () => {
      const rows = await cloud.fetchUnread({ agentUserId: AGENT })
      for (const row of rows) await cloud.markRead({ chatId: row.chatId, messageId: row.id, agentUserId: AGENT })
      throw new Error('SIGKILL before injection')
    }
    await expect(mutantAdvanceFirst()).rejects.toThrow('SIGKILL before injection')
    // 重启 → 重拉:游标已越过,消息再也拉不到 —— 静默丢。这个坏结果必须被读出来(红)。
    resetAgentInboxReaderStateForTests()
    const { deps, injections } = makeDeps(cloud)
    const result = await pullAgentInbox(AGENT, deps)
    expect(injections).toHaveLength(0)
    expect(result.pulled).toBe(0)
    expect(cloud.watermark('00000000-0000-4000-8000-000000000003', AGENT)).toBe(1) // 云端声称已读,而模型从未见过 —— 丢是静默的。
  })
})

describe('P-E6 已读回执:逐条精确读行 + 顺序消费下水位前进;水位停滞由精确读行兜住', () => {
  it('拉取后逐条精确读行按 seq 序写入,水位到 max(seq)', async () => {
    const cloud = new FakeCloud()
    cloud.addChat('00000000-0000-4000-8000-000000000003', 'group')
    cloud.join('00000000-0000-4000-8000-000000000003', AGENT, { listenMode: 'active' })
    cloud.join('00000000-0000-4000-8000-000000000003', HUMAN)
    cloud.post({ chatId: '00000000-0000-4000-8000-000000000003', id: '10000000-0000-4000-8000-00000000000f', seq: 1, senderUserId: HUMAN, senderType: 'human', content: 'a' })
    cloud.post({ chatId: '00000000-0000-4000-8000-000000000003', id: '10000000-0000-4000-8000-000000000010', seq: 2, senderUserId: HUMAN, senderType: 'human', content: 'b' })
    const { deps } = makeDeps(cloud)
    await pullAgentInbox(AGENT, deps)
    expect(cloud.markReadCalls.map((call) => call.messageId)).toEqual(['10000000-0000-4000-8000-00000000000f', '10000000-0000-4000-8000-000000000010'])
    expect(cloud.readRows.has(`10000000-0000-4000-8000-00000000000f:${AGENT}`)).toBe(true)
    expect(cloud.readRows.has(`10000000-0000-4000-8000-000000000010:${AGENT}`)).toBe(true)
    expect(cloud.watermark('00000000-0000-4000-8000-000000000003', AGENT)).toBe(2)
  })

  it('对方的 whisper 让水位永久停滞(生产现状),精确读行仍防住重注入', async () => {
    const cloud = new FakeCloud()
    cloud.addChat('00000000-0000-4000-8000-000000000003', 'group')
    cloud.join('00000000-0000-4000-8000-000000000003', AGENT, { listenMode: 'active' })
    cloud.join('00000000-0000-4000-8000-000000000003', HUMAN)
    // seq=1 是发给别人的 whisper:对本 agent 不可见,但 gap-guard 计入它。
    cloud.post({ chatId: '00000000-0000-4000-8000-000000000003', id: '10000000-0000-4000-8000-000000000020', seq: 1, senderUserId: HUMAN, senderType: 'human', content: 'psst', isWhisper: true, toUserIds: [OTHER_AGENT] })
    cloud.post({ chatId: '00000000-0000-4000-8000-000000000003', id: '10000000-0000-4000-8000-000000000010', seq: 2, senderUserId: HUMAN, senderType: 'human', content: 'visible' })
    const { deps, injections } = makeDeps(cloud)
    await pullAgentInbox(AGENT, deps)
    expect(injections).toHaveLength(1)
    expect(cloud.watermark('00000000-0000-4000-8000-000000000003', AGENT)).toBe(0) // 水位被 gap 卡住 —— 这就是「顺序消费下永不触发」不成立的读数。
    expect(cloud.readRows.has(`10000000-0000-4000-8000-000000000010:${AGENT}`)).toBe(true)
    // 若去重只靠水位,这里会重注入;精确读行必须防住。
    resetAgentInboxReaderStateForTests()
    await pullAgentInbox(AGENT, deps)
    expect(injections).toHaveLength(1)
  })
})

describe('P-E7 nudge 风暴:恰好一次注入', () => {
  function seed(): FakeCloud {
    const cloud = new FakeCloud()
    cloud.addChat('00000000-0000-4000-8000-000000000003', 'group')
    cloud.join('00000000-0000-4000-8000-000000000003', AGENT, { listenMode: 'active' })
    cloud.join('00000000-0000-4000-8000-000000000003', HUMAN)
    cloud.post({ chatId: '00000000-0000-4000-8000-000000000003', id: '10000000-0000-4000-8000-00000000000f', seq: 1, senderUserId: HUMAN, senderType: 'human', content: 'storm' })
    return cloud
  }

  it('并发 10 连触发被 single-flight 合并,transcript 恰好一次注入、游标恰好推进一次', async () => {
    const cloud = seed()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const injections: Injection[] = []
    const { deps } = makeDeps(cloud, {
      inject: async (input) => {
        injections.push({ messageId: input.messageId, text: input.text })
        await gate
        return 'accepted'
      },
    })
    const storm = Promise.all(Array.from({ length: 10 }, () => pullAgentInbox(AGENT, deps)))
    await new Promise((resolve) => setTimeout(resolve, 10))
    release()
    const results = await storm
    // coalescing:在飞时的触发合并成至多一轮 rerun;rerun 读到已推进的游标 → 零新注入。
    expect(injections).toHaveLength(1)
    expect(cloud.markReadCalls).toHaveLength(1)
    // #6264:每个被合并的触发拿到的结果如实报出那一次真实投递,❌ 不被空手的 rerun 覆盖成 0。
    for (const result of results) {
      expect(result).toMatchObject({ pulled: 1, injected: 1, verdict: 'accepted' })
    }
  })

  it('必失败对照①(摘掉 single-flight):并发双读者双注入,必须红', async () => {
    const cloud = seed()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const { deps, injections } = makeDeps(cloud, {
      inject: async (input) => {
        injections.push({ messageId: input.messageId, text: input.text })
        await gate
        return 'accepted'
      },
    })
    // 裸 pull ×2(绕过 single-flight)= 变异体。两个读者都在游标推进前读到同一批。
    const both = Promise.all([
      __pullOnceUnguardedForTests(AGENT, deps),
      __pullOnceUnguardedForTests(AGENT, deps),
    ])
    await new Promise((resolve) => setTimeout(resolve, 10))
    release()
    await both
    // 红:同一稳定 id 双注入(deps.inject 里 push 了一次,makeDeps 默认又 push 一次 —— 这里只看重复)。
    const ids = injections.map((entry) => entry.messageId)
    expect(ids.filter((id) => id === '10000000-0000-4000-8000-00000000000f').length).toBeGreaterThanOrEqual(2)
  })

  it('必失败对照②(游标推进被注释):跨触发重复注入,必须红', async () => {
    const cloud = seed()
    const { deps, injections } = makeDeps(cloud, {
      markRead: async () => { /* 变异:推进被注释掉 */ },
    })
    await pullAgentInbox(AGENT, deps)
    // 同进程内 in-memory overlay 会短暂遮住这个变异(它不持有跨崩溃真值);
    // 任何一次重启/另一个触发面就把坏结果显形 —— 这正是「游标才是真值」的证明。
    resetAgentInboxReaderStateForTests()
    await pullAgentInbox(AGENT, deps)
    expect(injections.map((entry) => entry.messageId)).toEqual(['10000000-0000-4000-8000-00000000000f', '10000000-0000-4000-8000-00000000000f'])
  })
})

describe('三态判决与失败面', () => {
  function seed(): FakeCloud {
    const cloud = new FakeCloud()
    cloud.addChat('00000000-0000-4000-8000-000000000003', 'group')
    cloud.join('00000000-0000-4000-8000-000000000003', AGENT, { listenMode: 'active' })
    cloud.join('00000000-0000-4000-8000-000000000003', HUMAN)
    cloud.post({ chatId: '00000000-0000-4000-8000-000000000003', id: '10000000-0000-4000-8000-00000000000f', seq: 1, senderUserId: HUMAN, senderType: 'human', content: 'hello' })
    return cloud
  }

  it('not-live:踢唤醒、游标不动、命中率交给下一个触发', async () => {
    const cloud = seed()
    const { deps, wakes } = makeDeps(cloud, { inject: async () => 'not-live' })
    const result = await pullAgentInbox(AGENT, deps)
    expect(result.verdict).toBe('not-live')
    expect(wakes).toEqual([AGENT])
    expect(cloud.markReadCalls).toEqual([])
  })

  it('keeps the real ACP pre-turn refusal unread, then delivers that exact message once after recovery without an error card', async () => {
    const { AcpRuntime, createAcpProcedures } = await import('@gugu/session-runtime/acp-agents')
    const { makeAcpHarness, makeStartInput } = await import('../../../../packages/session-runtime/src/acp-agents/acp-test-support')
    const h = makeAcpHarness()
    const runtime = new AcpRuntime(h.deps)
    const api = createAcpProcedures(runtime)
    const notices = vi.fn<typeof fetch>(async () => new Response('', { status: 201 }))
    vi.stubGlobal('fetch', notices)
    try {
      expect((await runtime.startSession(makeStartInput())).success).toBe(true)
      h.agent.prompt.mockRejectedValueOnce(Object.assign(new Error('Internal error'), {
        code: -32603, data: { details: 'Session not found' },
      }))
      const cloud = seed()
      const { deps, wakes } = makeDeps(cloud, { inject: async input => {
        const result = await api.promptDetached({ sessionId: 'conv-1', prompt: { text: input.text, origin: 'communication' } })
        return result.declined ? 'not-live' : {
          verdict: 'accepted', completion: api.waitPromptDetached({ requestId: result.requestId }).then(() => undefined),
        }
      } })
      expect(await pullAgentInbox(AGENT, deps)).toMatchObject({ verdict: 'not-live', injected: 0 })
      expect(cloud.markReadCalls).toEqual([])
      expect(wakes).toEqual([AGENT])
      expect(notices).not.toHaveBeenCalled()
      expect((await runtime.startSession(makeStartInput({ providerSessionId: 'session-1' }))).success).toBe(true)
      const delivered = await pullAgentInbox(AGENT, deps)
      await delivered.completion
      expect(delivered).toMatchObject({ verdict: 'accepted', injected: 1 })
      expect(cloud.markReadCalls).toHaveLength(1)
      expect(notices).not.toHaveBeenCalled()
      expect((await pullAgentInbox(AGENT, deps)).injected).toBe(0)
      expect(h.agent.prompt).toHaveBeenCalledTimes(2)
      expect(h.agent.prompt.mock.calls[0]?.[0].prompt).toEqual(h.agent.prompt.mock.calls[1]?.[0].prompt)
    } finally {
      await runtime.dispose()
      vi.unstubAllGlobals()
    }
  })

  it.each([
    ['ECONNRESET', 'network'], ['401 Unauthorized', 'authentication'], ['insufficient_quota', 'quota'],
  ])('settles a native failure before first output once, with its cause and no re-delivery: %s', async (cause, reason) => {
    const { AcpRuntime, createAcpProcedures } = await import('@gugu/session-runtime/acp-agents')
    const { makeAcpHarness, makeStartInput } = await import('../../../../packages/session-runtime/src/acp-agents/acp-test-support')
    const h = makeAcpHarness()
    const runtime = new AcpRuntime(h.deps)
    const api = createAcpProcedures(runtime)
    const cloud = seed()
    const notices: Array<{ reason: string }> = []
    try {
      await runtime.startSession(makeStartInput())
      h.agent.prompt.mockRejectedValueOnce(new Error(cause))
      const { deps } = makeDeps(cloud, { inject: async input => {
        const result = await api.promptDetached({ sessionId: 'conv-1', prompt: { text: input.text, origin: 'communication' } })
        return result.declined ? 'not-live' : {
          verdict: 'accepted', completion: api.waitPromptDetached({ requestId: result.requestId }).then(() => undefined),
        }
      }, postDisclosure: async input => { notices.push(input) } })
      const accepted = await pullAgentInbox(AGENT, deps)
      await accepted.completion!.catch(() => {})
      expect(notices).toEqual([expect.objectContaining({ reason })])
      expect(cloud.markReadCalls).toHaveLength(1)
      expect((await pullAgentInbox(AGENT, deps)).injected).toBe(0)
      expect(h.agent.prompt).toHaveBeenCalledTimes(1)
      expect(runtime.sessionsListLiveModel().states.list.snapshot().data['conv-1'])
        .toMatchObject({ isGenerating: false, lastTurnOutcome: 'errored' })
    } finally { await runtime.dispose() }
  })

  it('describes an unaccepted retained message as pending, and a later successful admission consumes it once', async () => {
    const post = vi.fn<typeof fetch>(async () => new Response('', { status: 201 }))
    vi.stubGlobal('fetch', post)
    try {
      await postDeliveryDisclosureRow({ agentUserId: AGENT, chatId: 'chat-a', key: 'notice', threadRootId: null, reason: 'notAdmitted' }, 'test-token')
      const body = JSON.parse(post.mock.calls[0]![1]!.body as string)
      expect(body.content).toBe('消息已保留，助理就绪后回复。')
      expect(body.content).not.toMatch(/failed|could not hand|失败/)
    } finally { vi.unstubAllGlobals() }
    const cloud = seed()
    const { deps } = makeDeps(cloud, { inject: async () => { throw new Error('runtime not ready') }, postDisclosure: async () => {} })
    await expect(pullAgentInbox(AGENT, deps)).rejects.toThrow('runtime not ready')
    expect(cloud.markReadCalls).toEqual([])
    const recovered = makeDeps(cloud)
    await pullAgentInbox(AGENT, recovered.deps)
    await pullAgentInbox(AGENT, recovered.deps)
    expect(recovered.injections.map(entry => entry.messageId)).toEqual(['10000000-0000-4000-8000-00000000000f'])
  })

  it('not-now(idle-only 忙):不唤醒、游标不动、等回合末', async () => {
    const cloud = seed()
    const { deps, wakes } = makeDeps(cloud, { inject: async () => 'not-now' })
    const result = await pullAgentInbox(AGENT, deps)
    expect(result.verdict).toBe('not-now')
    expect(wakes).toEqual([])
    expect(cloud.markReadCalls).toEqual([])
  })

  it('批注入真失败:游标不动、按来源 chat 落批粒度披露(只说原因,❌ 内部编号)、灯记异常、错误上抛', async () => {
    const cloud = seed()
    cloud.post({ chatId: '00000000-0000-4000-8000-000000000003', id: '10000000-0000-4000-8000-000000000010', seq: 2, senderUserId: HUMAN, senderType: 'human', content: 'boom' })
    const disclosures: Array<{ chatId: string; key: string; reason: string }> = []
    const { deps, outcomes } = makeDeps(cloud, {
      inject: async () => { throw new Error('provider exploded') },
      postDisclosure: async (input) => { disclosures.push({ chatId: input.chatId, key: input.key, reason: input.reason }) },
    })
    await expect(pullAgentInbox(AGENT, deps)).rejects.toThrow('provider exploded')
    expect(cloud.markReadCalls).toEqual([])
    expect(disclosures).toHaveLength(1)
    expect(disclosures[0]!.chatId).toBe('00000000-0000-4000-8000-000000000003')
    // #7103 owner 10-11:这一行给对话里所有人看 ⇒ 只带原因,❌ 内部编号、❌ 上游原文;没受理是咕咕这边的错。
    expect(disclosures[0]!.reason).toBe('notAdmitted')
    expect(outcomes).toEqual([{ ok: false }])
  })

  it('同一群消息的失败按 agent 去重;同一 agent 重拉仍用同一个 key', async () => {
    const cloud = new FakeCloud()
    cloud.addChat('00000000-0000-4000-8000-000000000003', 'group')
    cloud.join('00000000-0000-4000-8000-000000000003', AGENT)
    cloud.join('00000000-0000-4000-8000-000000000003', OTHER_AGENT)
    cloud.post({ chatId: '00000000-0000-4000-8000-000000000003', id: '10000000-0000-4000-8000-00000000000f', seq: 1, senderUserId: HUMAN, senderType: 'human', content: 'hello' })
    const keys: string[] = []
    const { deps } = makeDeps(cloud, {
      inject: async () => { throw new Error('provider failed') },
      postDisclosure: async ({ key }) => { keys.push(key) },
    })
    for (const agent of [AGENT, AGENT, OTHER_AGENT]) {
      await expect(pullAgentInbox(agent, deps)).rejects.toThrow('provider failed')
    }
    expect(keys).toHaveLength(3)
    expect(keys[0]).toBe(keys[1])
    expect(keys[0]).not.toBe(keys[2])
  })

  // 编号 17 (10-12): the row in the chat is this failure's one notice — the error says so, and the host adds no failure bar.
  // Only when the row is there: a post that failed leaves the failure unsaid, and the bar still comes up. Each failure is its
  // own (148 评审): the same error object thrown for a second batch whose row did not land is not taken as said.
  it('批失败的那一行落下了,上抛的错误就记作「已在 chat 里说过」;落不下就不记;同一个错误对象两批各算各的', async () => {
    const failure = new Error('provider exploded')
    for (const [post, said] of [[async () => {}, true], [async () => { throw new Error('post refused') }, false]] as const) {
      resetAgentInboxReaderStateForTests()
      const cloud = seed()
      const { deps } = makeDeps(cloud, { inject: async () => { throw failure }, postDisclosure: post })
      const thrown = await pullAgentInbox(AGENT, deps).then(() => null, (error: unknown) => error)
      expect(isSaidInChat(thrown)).toBe(said)
      expect((thrown as Error).message).toBe('provider exploded')
      expect(said ? (thrown as Error).cause : thrown).toBe(failure)
    }
    expect(isSaidInChat(failure)).toBe(false)
    expect(isSaidInChat(new Error('never pulled'))).toBe(false)
  })

  it('reports a quota failure after admission, even when a wake pull owns the turn instead of a command', async () => {
    const cloud = seed()
    let fail!: (error: Error) => void
    const completion = new Promise<void>((_, reject) => { fail = reject })
    const notices: Array<{ reason: string; chatId: string }> = []
    const { deps } = makeDeps(cloud, {
      inject: async () => ({ verdict: 'accepted', completion }),
      postDisclosure: async (input) => { notices.push(input) },
    })
    const admitted = await pullAgentInbox(AGENT, deps)
    const settled = admitted.completion!.catch((error: unknown) => error)
    expect(cloud.markReadCalls).toHaveLength(1)
    // A subsequent nudge sees no unread rows. It cannot own this provider failure.
    await expect(pullAgentInbox(AGENT, deps)).resolves.toMatchObject({ injected: 0 })
    fail(new Error("Internal error: You've hit your weekly limit; private trace x123"))
    expect(isSaidInChat(await settled)).toBe(true)
    expect(notices).toEqual([expect.objectContaining({ chatId: '00000000-0000-4000-8000-000000000003', reason: 'weeklyQuota' })])
    expect(cloud.markReadCalls).toHaveLength(1)
  })

  it.each([
    'API Error: 400 Model private/deepseek is not available (request id: private-trace)',
    'Selected model is at capacity. Please try a different model.',
  ])('discloses an unavailable model without leaking its upstream route or request trace: %s', async (reason) => {
    const cloud = seed()
    const notices: Array<{ reason: string }> = []
    const { deps } = makeDeps(cloud, {
      inject: async () => ({ verdict: 'accepted', completion: Promise.reject(new Error(reason)) }),
      postDisclosure: async (input) => { notices.push(input) },
    })
    const admitted = await pullAgentInbox(AGENT, deps)
    await admitted.completion!.catch(() => {})
    expect(notices).toEqual([expect.objectContaining({ reason: 'modelUnavailable' })])
  })

  // Beta 1042: the agent's message_send landed, then the provider rejected the request after it (API Error: 400) and the
  // chat got 「Agent 本次回复出错，未能完成」 under the reply it had just read.
  it('posts no failure row under a reply the agent already sent on that line', async () => {
    const cloud = seed()
    const asked: unknown[] = []
    const notices: unknown[] = []
    const { deps } = makeDeps(cloud, {
      inject: async () => ({ verdict: 'accepted', completion: Promise.reject(new Error('API Error: 400 Invalid request parameters.')) }),
      agentSpokeAfter: async (input) => { asked.push(input); return true },
      postDisclosure: async (input) => { notices.push(input) },
    })
    const admitted = await pullAgentInbox(AGENT, deps)
    const error = await admitted.completion!.catch((failure: unknown) => failure)
    expect(asked).toEqual([{ agentUserId: AGENT, chatId: '00000000-0000-4000-8000-000000000003', threadRootId: null, afterSeq: 1 }])
    expect(notices).toEqual([])
    // The chat holds its answer: the host adds no notice of its own either.
    expect(isSaidInChat(error)).toBe(true)
  })

  it('still says the failure when the agent did not answer, or when that cannot be read', async () => {
    for (const spoke of [async () => false, async () => { throw new Error('history read refused') }]) {
      resetAgentInboxReaderStateForTests()
      const cloud = seed()
      const notices: unknown[] = []
      const { deps } = makeDeps(cloud, {
        inject: async () => ({ verdict: 'accepted', completion: Promise.reject(new Error('API Error: 400 Invalid request parameters.')) }),
        agentSpokeAfter: spoke,
        postDisclosure: async (input) => { notices.push(input) },
      })
      const admitted = await pullAgentInbox(AGENT, deps)
      await admitted.completion!.catch(() => {})
      expect(notices).toEqual([expect.objectContaining({ chatId: '00000000-0000-4000-8000-000000000003', reason: 'generic' })])
    }
  })

  it('does not ask whether the agent answered a batch that was never admitted', async () => {
    const cloud = seed()
    const asked: unknown[] = []
    const notices: unknown[] = []
    const { deps } = makeDeps(cloud, {
      inject: async () => { throw new Error('runtime not ready') },
      agentSpokeAfter: async (input) => { asked.push(input); return true },
      postDisclosure: async (input) => { notices.push(input) },
    })
    await pullAgentInbox(AGENT, deps).catch(() => {})
    expect(asked).toEqual([])
    expect(notices).toHaveLength(1)
  })

  it('keeps a completion failure unsaid if its durable notice could not be written', async () => {
    const cloud = seed()
    let fail!: (error: Error) => void
    const completion = new Promise<void>((_, reject) => { fail = reject })
    const { deps } = makeDeps(cloud, {
      inject: async () => ({ verdict: 'accepted', completion }),
      postDisclosure: async () => { throw new Error('write refused') },
    })
    const admitted = await pullAgentInbox(AGENT, deps)
    const settled = admitted.completion!.catch((error: unknown) => error)
    fail(new Error('provider failed'))
    const error = await settled
    expect(isSaidInChat(error)).toBe(false)
    expect((error as Error).message).toBe('provider failed')
  })

  it('queued ACP admission advances once so the turn-end dequeue cannot duplicate', async () => {
    const cloud = seed()
    const machineQueue: string[] = []
    const injections: string[] = []
    const { deps } = makeDeps(cloud, {
      inject: async (input) => {
        injections.push(input.messageId!)
        machineQueue.push(input.messageId!)
        return { verdict: 'accepted', completion: Promise.resolve() }
      },
    })

    await expect(pullAgentInbox(AGENT, deps)).resolves.toMatchObject({ verdict: 'accepted', injected: 1 })
    expect(cloud.markReadCalls).toEqual([{ chatId: '00000000-0000-4000-8000-000000000003', messageId: '10000000-0000-4000-8000-00000000000f' }])
    expect(machineQueue).toEqual(['10000000-0000-4000-8000-00000000000f'])

    // The ACP machine drains its queued prompt at TurnEnded; the reader already advanced the
    // durable cloud cursor at admission, so the next trigger has nothing to pull.
    machineQueue.shift()
    await expect(pullAgentInbox(AGENT, deps)).resolves.toMatchObject({ verdict: 'idle', injected: 0 })
    expect(injections).toEqual(['10000000-0000-4000-8000-00000000000f'])
    expect(cloud.markReadCalls).toEqual([{ chatId: '00000000-0000-4000-8000-000000000003', messageId: '10000000-0000-4000-8000-00000000000f' }])
  })

  it('kick 入口吞不了错:失败只 loud log,游标滞后留给下一个触发', async () => {
    const cloud = seed()
    const { deps } = makeDeps(cloud, {
      inject: async () => { throw new Error('boom') },
      postDisclosure: async () => {},
    })
    kickAgentInboxPull(AGENT, deps, 'unit')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(cloud.markReadCalls).toEqual([])
  })

})

// @@@5856 「must-reply 违约判定」那一组随**老 active 档**一起删了:两档之后留下的 active 是
// 「叫得醒它,回不回它自己判断」,对它判「该回没回」判出来的全是假违约,而那盏灯喂的是
// recordDeliverOutcome(异常计数)。判据没了对象,测试跟着走,❌ 不留一组永远绿的空壳。


describe('#6036 unread scan pagination', () => {
  // 资格判断在 RPC 里(#6077):不该交给这个 agent 的行根本不回来,「一页被不相干的行占满」在 reader
  // 这一侧不再存在。这里盯的是 reader 自己的分页:一页装满就带着游标接着扫,扫描有界,失败后从未读真值重来。
  function seed(backlog: number): FakeCloud {
    const cloud = new FakeCloud()
    cloud.addChat('00000000-0000-4000-8000-000000000003', 'group')
    cloud.addChat('00000000-0000-4000-8000-000000000011', 'dm')
    cloud.join('00000000-0000-4000-8000-000000000003', AGENT)
    cloud.join('00000000-0000-4000-8000-000000000011', AGENT)
    for (let seq = 1; seq <= backlog; seq += 1) {
      cloud.post({ chatId: '00000000-0000-4000-8000-000000000003', id: `30000000-0000-4000-8000-${String(seq).padStart(12, '0')}`, seq, senderUserId: HUMAN, senderType: 'human', toUserIds: [AGENT], content: `request ${seq}` })
    }
    cloud.post({ chatId: '00000000-0000-4000-8000-000000000003', id: '10000000-0000-4000-8000-000000000012', seq: backlog + 1, senderUserId: OTHER_AGENT, senderType: 'agent', toUserIds: [AGENT], content: '@target' })
    cloud.post({ chatId: '00000000-0000-4000-8000-000000000011', id: '40000000-0000-4000-8000-000000000001', seq: 1, senderUserId: HUMAN, senderType: 'human', toUserIds: [AGENT], content: 'private request' })
    return cloud
  }
  const backlogIds = (backlog: number): string[] => Array.from({ length: backlog }, (_, index) => `30000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`)

  it.each([80, 161, 80 * 10])('drains a %i-row backlog, the later @ and a lower-seq DM, each exactly once', async (backlog) => {
    const cloud = seed(backlog)
    const { deps, injections } = makeDeps(cloud)
    const result = await pullAgentInbox(AGENT, deps)
    const expected = [...backlogIds(backlog), '10000000-0000-4000-8000-000000000012', '40000000-0000-4000-8000-000000000001']
    expect(result).toMatchObject({ pulled: backlog + 2, injected: backlog + 2 })
    expect(injections.map((row) => row.messageId)).toEqual(expected)
    expect(cloud.markReadCalls.map((row) => row.messageId)).toEqual(expected)
    expect(cloud.watermark('00000000-0000-4000-8000-000000000003', AGENT)).toBe(backlog + 1)
    await pullAgentInbox(AGENT, deps)
    expect(injections).toHaveLength(expected.length)
    resetAgentInboxReaderStateForTests()
    await pullAgentInbox(AGENT, deps)
    expect(injections).toHaveLength(expected.length)
  })

  it.each(['throw', 'not-live', 'not-now', 'read-failure'] as const)('a %s scan leaves its rows unread; the retry starts from unread truth', async (failure) => {
    const cloud = seed(0)
    cloud.post({ chatId: '00000000-0000-4000-8000-000000000003', id: '10000000-0000-4000-8000-00000000000d', seq: 2, senderUserId: HUMAN, senderType: 'human', toUserIds: [AGENT], content: 'follow-up' })
    const first = makeDeps(cloud, {
      inject: async () => {
        if (failure === 'throw') throw new Error('provider unavailable')
        return failure === 'read-failure' ? 'accepted' : failure
      },
      markRead: async () => { throw new Error('receipt unavailable') },
      postDisclosure: async () => {},
    })
    if (failure === 'throw' || failure === 'read-failure') await expect(pullAgentInbox(AGENT, first.deps)).rejects.toThrow('unavailable')
    else expect((await pullAgentInbox(AGENT, first.deps)).verdict).toBe(failure)
    expect(cloud.readRows.size).toBe(0)
    const retry = makeDeps(cloud)
    await pullAgentInbox(AGENT, retry.deps)
    expect(retry.injections.map((row) => row.messageId)).toEqual(['10000000-0000-4000-8000-000000000012', '10000000-0000-4000-8000-00000000000d', '40000000-0000-4000-8000-000000000001'])
    expect(cloud.markReadCalls.map((row) => row.messageId)).toEqual(['10000000-0000-4000-8000-000000000012', '10000000-0000-4000-8000-00000000000d', '40000000-0000-4000-8000-000000000001'])
  })

  it('resumes from unread truth after a second-page failure without repeating accepted rows', async () => {
    const cloud = seed(160)
    const accepted: string[] = []
    let fail = true
    const { deps } = makeDeps(cloud, {
      inject: async ({ messageId }) => {
        if (messageId === '30000000-0000-4000-8000-000000000081' && fail) throw new Error('second page failure')
        accepted.push(messageId!)
        return 'accepted'
      },
      postDisclosure: async () => {},
    })
    await expect(pullAgentInbox(AGENT, deps)).rejects.toThrow('second page failure')
    expect(accepted).toEqual(backlogIds(80))
    fail = false
    await pullAgentInbox(AGENT, deps)
    expect(accepted).toEqual([...backlogIds(160), '10000000-0000-4000-8000-000000000012', '40000000-0000-4000-8000-000000000001'])
  })

  it('a finite scan excludes new traffic and the next trigger recovers messages behind its chat cursor', async () => {
    const cloud = seed(80)
    const requests: AgentInboxFetchInput[] = []
    let fenceAtFirstPage: number | undefined
    const { deps, injections } = makeDeps(cloud, {
      fetchUnread: async (input) => {
        requests.push(input)
        if (requests.length === 1) fenceAtFirstPage = cloud.ingest
        if (requests.length === 2) {
          cloud.advanceClock('2026-08-29T00:01:00.000Z')
          cloud.post({ chatId: '00000000-0000-4000-8000-000000000003', id: '10000000-0000-4000-8000-000000000016', seq: 82, senderUserId: HUMAN, senderType: 'human', toUserIds: [AGENT], content: 'arrived while scanning' })
          cloud.addChat('00000000-0000-4000-8000-000000000002', 'dm')
          cloud.join('00000000-0000-4000-8000-000000000002', AGENT)
          cloud.post({ chatId: '00000000-0000-4000-8000-000000000002', id: '10000000-0000-4000-8000-000000000015', seq: 1, senderUserId: HUMAN, senderType: 'human', toUserIds: [AGENT], content: 'behind cursor' })
        }
        return cloud.fetchUnread(input)
      },
    })
    await pullAgentInbox(AGENT, deps)
    expect(injections.map((row) => row.messageId)).toEqual([...backlogIds(80), '10000000-0000-4000-8000-000000000012', '40000000-0000-4000-8000-000000000001'])
    expect(requests[1]).toMatchObject({ scanAfter: { chatId: '00000000-0000-4000-8000-000000000003', seq: 80 }, scanFence: fenceAtFirstPage })
    await pullAgentInbox(AGENT, deps)
    expect(injections.map((row) => row.messageId)).toEqual([...backlogIds(80), '10000000-0000-4000-8000-000000000012', '40000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000015', '10000000-0000-4000-8000-000000000016'])
  })

  it('does not count local pending rows toward cloud page fullness', async () => {
    const cloud = seed(0)
    let requests = 0
    const { deps } = makeDeps(cloud, {
      fetchUnread: async (input) => { requests += 1; return cloud.fetchUnread(input) },
      fetchLocalUnread: async () => Array.from({ length: 80 }, (_, i) => ({
        ...awaitlessRow(), id: `local-${i}`, localSessionDirect: { sessionId: 'local', envelope: 'local' },
      })),
      markLocalRead: async () => {},
    })
    function awaitlessRow(): AgentInboxUnreadRow {
      return { chatId: 'local', chatKind: 'dm', chatPublicId: null, chatName: null, chatCreatorUserId: null,
        listenMode: 'active', notificationLevel: 'all', lastReadSeq: 0, id: 'local', seq: 1,
        senderUserId: HUMAN, senderType: 'human', senderDisplayName: 'Ada', senderGuguNumber: null,
        content: 'hi', contentType: 'text', toUserIds: [AGENT], isWhisper: false,
        replyToMessageId: null, replyToSenderUserId: null, replyToContent: null,
        threadRootId: null, isThreadRoot: false, createdAt: cloud.now }
    }
    expect((await pullAgentInbox(AGENT, deps)).injected).toBe(82)
    expect(requests).toBe(1)
  })
})

describe('#6264 合并触发的合账', () => {
  it('前后几轮累加行数与注入数,空手的 rerun 不改写判决', () => {
    expect(combineCoalescedPulls(
      { pulled: 1, injected: 1, verdict: 'accepted' },
      { pulled: 0, injected: 0, verdict: 'idle' },
    )).toEqual({ pulled: 1, injected: 1, verdict: 'accepted' })
  })

  it('后一轮有事实时以后一轮的判决为准', () => {
    expect(combineCoalescedPulls(
      { pulled: 2, injected: 2, verdict: 'accepted' },
      { pulled: 1, injected: 0, verdict: 'not-live' },
    )).toEqual({ pulled: 3, injected: 2, verdict: 'not-live' })
  })
})

// Beta 1040: a turn-failure notice is stored under a structured key (`turn-failure:batch:<hash>`) and answers the message
// that dispatched the failed turn, so it reaches the agent that sent that message. Its reader delivers it like any row —
// one id it cannot address must not stop that agent's whole inbox — and a row it cannot prepare is disclosed, not dropped.
describe('a failure notice from another agent reaches the agent whose message it answers', () => {
  const CHAT = '00000000-0000-4000-8000-0000000000a1'
  const NOTICE = 'turn-failure:batch:6b62191fcf9bbff3312a90753053be57'
  const LATER = '10000000-0000-4000-8000-0000000000a2'

  function seed(): FakeCloud {
    const cloud = new FakeCloud()
    cloud.addChat(CHAT, 'group')
    cloud.join(CHAT, AGENT)
    cloud.join(CHAT, OTHER_AGENT)
    cloud.post({
      chatId: CHAT, id: NOTICE, seq: 1, senderUserId: OTHER_AGENT, senderType: 'agent', content: 'Delivery failed.',
      replyToMessageId: '10000000-0000-4000-8000-0000000000a0', replyToSenderUserId: AGENT,
    })
    cloud.post({ chatId: CHAT, id: LATER, seq: 2, senderUserId: HUMAN, senderType: 'human', content: 'still there?' })
    return cloud
  }

  it('delivers the notice under its own id and the message after it, and reads both', async () => {
    const cloud = seed()
    const { deps, injections } = makeDeps(cloud)
    const result = await pullAgentInbox(AGENT, deps)
    expect(result.injected).toBe(2)
    expect(injections[0]!.text).toContain(`msg="msg:${NOTICE}"`)
    expect(injections[1]!.text).toContain(`msg="msg:${LATER}"`)
    expect(cloud.markReadCalls.map((call) => call.messageId)).toEqual([NOTICE, LATER])
  })

  it('a row that cannot be prepared is disclosed to its chat and the real error is what the pull throws', async () => {
    const cloud = seed()
    const disclosures: Array<{ chatId: string; reason: string }> = []
    const { deps, injections, outcomes } = makeDeps(cloud, {
      resolveGuguIds: async () => { throw new Error('identity lookup refused') },
      postDisclosure: async (input) => { disclosures.push({ chatId: input.chatId, reason: input.reason }) },
    })
    const thrown = await pullAgentInbox(AGENT, deps).then(() => null, (error: unknown) => error)
    expect((thrown as Error).message).toBe('identity lookup refused')
    expect(isSaidInChat(thrown)).toBe(true)
    expect(injections).toEqual([])
    expect(disclosures).toEqual([{ chatId: CHAT, reason: 'notAdmitted' }])
    expect(cloud.markReadCalls).toEqual([])
    expect(outcomes).toEqual([{ ok: false }])
  })

  it('writes a new notice under a UUID derived from its key; its marker still names it and links reach it', async () => {
    const post = vi.fn<typeof fetch>(async () => new Response('', { status: 201 }))
    vi.stubGlobal('fetch', post)
    try {
      const row = { agentUserId: OTHER_AGENT, chatId: CHAT, key: NOTICE, threadRootId: null, reason: 'quota' as const }
      await postDeliveryDisclosureRow(row, 'test-token')
      await postDeliveryDisclosureRow(row, 'test-token')
      const [first, second] = post.mock.calls.map((call) => JSON.parse(call[1]!.body as string))
      expect(first.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
      expect(second.id).toBe(first.id)
      expect(parseSystemNotice({ id: first.id, content_type: 'system', sender_user_id: OTHER_AGENT, client_message_id: first.client_message_id }))
        .toEqual({ kind: 'turn-failure', reason: 'quota' })
      expect(storedMessageLink(CHAT, first.id)).toBe(`gugu-chat://${CHAT}/${first.id}`)
      // A notice stored under its key before this: still a message, reached through its conversation.
      expect(storedMessageLink(CHAT, NOTICE)).toBe(`gugu-chat://${CHAT}`)
    } finally { vi.unstubAllGlobals() }
  })
})

describe('agentSpokeAfterViaRpc', () => {
  const input = { agentUserId: AGENT, chatId: 'chat-1', threadRootId: null, afterSeq: 5 }
  const reply = (rows: unknown[]) => (async () => new Response(JSON.stringify(rows), { status: 200 })) as unknown as typeof fetch

  beforeEach(() => {
    vi.stubEnv('GUGU_SUPABASE_URL', 'https://db.test')
    vi.stubEnv('GUGU_SUPABASE_ANON_KEY', 'anon')
    return () => { vi.unstubAllEnvs() }
  })

  it('reads the line as the agent and counts only its own non-system message after the batch', async () => {
    let body: unknown
    const spy = (async (_url: string, init: RequestInit) => { body = JSON.parse(String(init.body)); return new Response('[]') }) as unknown as typeof fetch
    await agentSpokeAfterViaRpc(input, 'token', spy)
    expect(body).toEqual({ p_chat_id: 'chat-1', p_as_user_id: AGENT, p_thread_root_id: null, p_limit: 20 })
    const others = [
      { seq: 7, sender_user_id: AGENT, content_type: 'system' },
      { seq: 5, sender_user_id: AGENT, content_type: 'text' },
      { seq: 8, sender_user_id: 'someone-else', content_type: 'text' },
    ]
    await expect(agentSpokeAfterViaRpc(input, 'token', reply(others))).resolves.toBe(false)
    await expect(agentSpokeAfterViaRpc(input, 'token', reply([...others, { seq: 6, sender_user_id: AGENT, content_type: 'text' }]))).resolves.toBe(true)
  })

  it('throws when the history cannot be read', async () => {
    const refused = (async () => new Response('nope', { status: 403 })) as unknown as typeof fetch
    await expect(agentSpokeAfterViaRpc(input, 'token', refused)).rejects.toThrow('message_history_as failed: HTTP 403')
  })
})
