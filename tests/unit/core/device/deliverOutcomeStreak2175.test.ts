// @@@#2175 验收 · tick 级 deliver 回合结局接线(runDeviceRuntimeTick,S2b pull 模型):
//  喂灯点从命令结果迁到读者注入结局(handleAgentDeliverDeviceCommand 的 recordDeliverOutcome →
//  reader onOutcome):注入受理 → ok:true 清零;批注入失败(inject throw)→ ok:false;
//  active must-reply 违约(下一次 pull 开场结算)→ ok:false;拉回空(引擎没跑)→ 不记录;
//  瞬态网络失败(pull 阶段,init 窗口内)→ held 不动计数;记录自身失败 → best-effort,不影响命令流转。
//  网络面全 stub:pull_agent_inbox / mark_read_on_deliver / must-reply 读数都走 fetch 路由桩。
import { afterEach, describe, expect, test, vi } from 'vitest'
import { runDeviceRuntimeTick } from '@gugu/core'
import { writeAgentRuntimeSession } from '@gugu/core/local/agent/agentRuntimeSession'
import type { AgentDeliverOutcomeInput } from '@gugu/core/local/agent/agentDeliverOutcome'
import {
  resetAgentInboxReaderStateForTests,
  type AgentInboxInjectionInput,
  type AgentInboxInjectionVerdict,
} from '@gugu/core/local/agent/agentInboxReader'
import {
  createTestLocalAgent,
  deviceCommandRow,
  isolatedGuguEnv,
  MemoryHeartbeatClient,
  pollOnlyMemoryDeviceCommandClient,
  testAgentDeliverPayload,
} from '../../../support/deviceRuntimeHarness'

const JSON_HEADERS = { 'Content-Type': 'application/json' }
const FENCED_COMMAND_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const FENCED_AGENT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const FENCED_CHAT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const FENCED_SENDER_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const FENCED_MESSAGE_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'

/** 一行 = pull_agent_inbox RPC 的原始行(snake_case;RPC 返回的行都是该交给本 agent 的)。 */
function unreadRow(overrides: Record<string, unknown> = {}) {
  return {
    chat_id: FENCED_CHAT_ID,
    chat_kind: 'group',
    chat_public_id: 42,
    chat_name: '测试群',
    chat_creator_user_id: FENCED_SENDER_ID,
    listen_mode: null,
    notification_level: 'all',
    last_read_seq: 0,
    id: FENCED_MESSAGE_ID,
    seq: 1,
    sender_user_id: FENCED_SENDER_ID,
    sender_type: 'human',
    sender_display_name: '房主',
    sender_gugu_number: 7,
    content: '请回复',
    content_type: 'text',
    to_user_ids: [FENCED_AGENT_ID],
    is_whisper: false,
    reply_to_message_id: null,
    reply_to_sender_user_id: null,
    reply_to_content: null,
    thread_root_id: null,
    is_thread_root: false,
    created_at: '2026-08-29T00:00:00.000Z',
    file_item_id: null,
    file_version: null,
    file_blob_id: null,
    ...overrides,
  }
}

function stubNetwork(options: {
  unreadRows?: () => unknown[]
  pullFailure?: () => Error | null
  /** must-reply 结算读到的「agent 已回」行集(默认空 = 没回)。 */
  agentReplies?: unknown[]
  /** 批失败披露那一行的 POST 回什么(默认 201 = 落下了)。 */
  disclosureStatus?: number
} = {}) {
  vi.stubEnv('GUGU_SUPABASE_URL', 'https://db.example.test')
  vi.stubEnv('GUGU_SUPABASE_ANON_KEY', 'anon-key')
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input)
      const method = (input instanceof Request ? input.method : init?.method ?? 'GET').toUpperCase()
      if (url.includes('/rpc/pull_agent_inbox_v2')) {
        const failure = options.pullFailure?.()
        if (failure) throw failure
        return new Response(JSON.stringify(options.unreadRows?.() ?? []), { status: 200, headers: JSON_HEADERS })
      }
      if (url.includes('/rpc/mark_read_on_deliver')) {
        return new Response('null', { status: 200, headers: JSON_HEADERS })
      }
      if (url.includes('/rest/v1/chat_members')) {
        // must-reply 可见域锚:owner 在场。
        return new Response(JSON.stringify([{ chat_id: FENCED_CHAT_ID }]), { status: 200, headers: JSON_HEADERS })
      }
      if (url.includes('/rest/v1/messages') && method === 'POST') {
        // 批失败披露的稳定 id 直插。
        return new Response('', { status: options.disclosureStatus ?? 201 })
      }
      if (url.includes('/rest/v1/messages')) {
        return new Response(JSON.stringify(options.agentReplies ?? []), { status: 200, headers: JSON_HEADERS })
      }
      // 其余 GET(身份解析等)容错面:空集即可。
      return new Response('[]', { status: 200, headers: JSON_HEADERS })
    }),
  )
}

afterEach(() => {
  resetAgentInboxReaderStateForTests()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

async function seedAgent(env: NodeJS.ProcessEnv) {
  await createTestLocalAgent(
    env,
    { gugu_user_id: FENCED_AGENT_ID },
    { cache: { acp_engine_id: 'claude' }, dm_chat_id: FENCED_CHAT_ID },
  )
  await writeAgentRuntimeSession({ agentUserId: FENCED_AGENT_ID, accessToken: 'owner-token', refreshToken: '' }, env)
}

async function runDeliverTick(
  env: NodeJS.ProcessEnv,
  injectAgentInbox: (input: AgentInboxInjectionInput) => Promise<AgentInboxInjectionVerdict>,
  outcomes: AgentDeliverOutcomeInput[],
  options: {
    commandId?: string
    commandCreatedAt?: string
    recordDeliverOutcome?: (o: AgentDeliverOutcomeInput) => Promise<unknown>
    withoutAccessToken?: boolean
    onAgentDeliverFailure?: (failure: { commandId: string; chatId: string }) => void
  } = {},
) {
  const commandId = options.commandId ?? FENCED_COMMAND_ID
  const commandClient = pollOnlyMemoryDeviceCommandClient(
    [
      deviceCommandRow({
        id: commandId,
        deviceId: 'device-1',
        type: 'agent.deliver',
        payload: testAgentDeliverPayload({
          agent_user_id: FENCED_AGENT_ID,
          chat_id: FENCED_CHAT_ID,
          message_id: FENCED_MESSAGE_ID,
          sender_user_id: FENCED_SENDER_ID,
          to_user_ids: [FENCED_AGENT_ID],
        }),
        createdAt: options.commandCreatedAt,
      }),
    ],
    'deliver outcome tick',
  )
  const result = await runDeviceRuntimeTick(
    {
      userId: 'owner-1',
      deviceId: 'device-1',
      commandClient,
      heartbeatClient: new MemoryHeartbeatClient(),
      syncHeartbeat: false,
      accessToken: options.withoutAccessToken ? undefined : 'owner-token',
      runtimeBridge: {
        create: async () => {},
        injectAgentInbox,
        stop: async () => {},
      },
      recordDeliverOutcome:
        options.recordDeliverOutcome ??
        (async (o: AgentDeliverOutcomeInput) => {
          outcomes.push(o)
          return 0
        }),
      ...(options.onAgentDeliverFailure ? { onAgentDeliverFailure: options.onAgentDeliverFailure } : {}),
    },
    env,
  )
  // recordDeliverOutcome 是 fire-and-forget 的微任务链,冲一拍再让调用方断言计数。
  await new Promise((resolve) => setImmediate(resolve))
  return { result, commandClient, commandId }
}

describe('#2175 deliver 回合结局接线(tick 级,S2b 读者注入结局)', () => {
  test('missing owner token fails the command before any injection', async () => {
    const env = await isolatedGuguEnv('gugu-2175-missing-owner-token-')
    await seedAgent(env)
    stubNetwork({ unreadRows: () => [unreadRow()] })
    let injections = 0
    const outcomes: AgentDeliverOutcomeInput[] = []
    const { result, commandClient } = await runDeliverTick(
      env,
      async () => {
        injections += 1
        return 'accepted'
      },
      outcomes,
      { withoutAccessToken: true },
    )
    expect(result.commands).toMatchObject([{ commandId: FENCED_COMMAND_ID, status: 'error' }])
    expect(commandClient.row(FENCED_COMMAND_ID)).toMatchObject({ status: 'error' })
    expect(injections).toBe(0)
  })

  test('注入受理 → 记录 ok:true(成功清零),命令 done', async () => {
    const env = await isolatedGuguEnv('gugu-2175-streak-ok-')
    await seedAgent(env)
    stubNetwork({ unreadRows: () => [unreadRow()] })
    const injected: AgentInboxInjectionInput[] = []
    const outcomes: AgentDeliverOutcomeInput[] = []
    const { result } = await runDeliverTick(
      env,
      async (input) => {
        injected.push(input)
        return 'accepted'
      },
      outcomes,
    )

    expect(result.commands).toMatchObject([{ commandId: FENCED_COMMAND_ID, status: 'done' }])
    expect(injected).toHaveLength(1)
    expect(outcomes).toEqual([{ agentUserId: FENCED_AGENT_ID, ok: true }])
  })

  // '#3684 cloud agent.deliver carries exact trigger source and lease facts' 已删 ——
  // per-turn commandContext/lease 随 S2b pull flip 退役,nudge 不再携带 claim/context。
  // '[NO_REPLY] 静默 skip' 与 'provider output text' 两例已删 —— provider 回合输出不再流经
  // deliver handler(S2b pull flip),灯只读注入结局与 must-reply 结算。

  // @@@5856 'active must-reply 违约 → 下一次 pull 开场结算记 ok:false' 已删 —— 响应档位收成两档之后,
  // 留下的 active 是「叫得醒它,回不回它自己判断」,对它判「该回没回」判出来的全是假违约,
  // 而这盏灯(recordDeliverOutcome)正是异常计数。判据没有对象了,这一格跟着走,❌ 不留空壳。

  test('批注入失败(inject throw)→ 记录 ok:false,命令 error', async () => {
    const env = await isolatedGuguEnv('gugu-2175-streak-fail-')
    await seedAgent(env)
    stubNetwork({ unreadRows: () => [unreadRow()] })
    const outcomes: AgentDeliverOutcomeInput[] = []
    const { result, commandClient } = await runDeliverTick(
      env,
      async () => {
        throw new Error('engine exploded')
      },
      outcomes,
    )

    expect(result.commands).toMatchObject([{ commandId: FENCED_COMMAND_ID, status: 'error' }])
    expect(commandClient.row(FENCED_COMMAND_ID)).toMatchObject({ status: 'error' })
    // 两个喂灯点各记一次:读者的批注入失败 + 命令终态失败(onCommandFailed)。都只说「异常」,不清零。
    expect(outcomes).toEqual([
      { agentUserId: FENCED_AGENT_ID, ok: false },
      { agentUserId: FENCED_AGENT_ID, ok: false },
    ])
  })

  // 编号 17 (10-12 片场试演):群里那一行就是这次失败的唯一说明 —— 落下了,宿主就不再叠失败条(那条条在 agent 恢复以后
  // 从来没人收);计数照记。那一行没落下(POST 被拒),失败条照常出,不让失败无声。
  test('批注入失败且披露行落下 → 不出失败条、计数照记;披露行落不下 → 照常出条', async () => {
    for (const [disclosureStatus, bars] of [[201, 0], [500, 1]] as const) {
      resetAgentInboxReaderStateForTests()
      const env = await isolatedGuguEnv(`gugu-17-said-${disclosureStatus}-`)
      await seedAgent(env)
      stubNetwork({ unreadRows: () => [unreadRow()], disclosureStatus })
      const outcomes: AgentDeliverOutcomeInput[] = []
      const failures: { commandId: string; chatId: string }[] = []
      const { result } = await runDeliverTick(
        env,
        async () => {
          throw new Error('engine exploded')
        },
        outcomes,
        { onAgentDeliverFailure: (failure) => failures.push(failure) },
      )
      expect(result.commands).toMatchObject([{ commandId: FENCED_COMMAND_ID, status: 'error' }])
      expect(failures.map((failure) => failure.chatId)).toEqual(Array(bars).fill(FENCED_CHAT_ID))
      expect(outcomes.filter((outcome) => !outcome.ok)).toHaveLength(2)
      vi.unstubAllGlobals()
    }
  })

  test('拉回空(没有该交给它的行,引擎没跑)→ 不记录,失败灯不被无证据清掉', async () => {
    const env = await isolatedGuguEnv('gugu-2175-streak-empty-pull-')
    await seedAgent(env)
    // 不唤醒这个 agent 的消息(如 agent 发的群内无点名发言,#1671)RPC 根本不返回(#6077)⇒ 这次 nudge 拉回空。
    stubNetwork({ unreadRows: () => [] })
    let injections = 0
    const outcomes: AgentDeliverOutcomeInput[] = []
    const { result } = await runDeliverTick(
      env,
      async () => {
        injections += 1
        return 'accepted'
      },
      outcomes,
    )

    expect(result.commands).toMatchObject([{ commandId: FENCED_COMMAND_ID, status: 'done' }])
    expect(injections, '空拉不进引擎').toBe(0)
    expect(outcomes, '没跑引擎 = 无健康证据,不清零不累计').toEqual([])
  })

  test('held(pull 阶段瞬态网络失败,init 窗口内)→ 不动计数,命令留 pending 重投', async () => {
    const env = await isolatedGuguEnv('gugu-2175-streak-held-')
    await seedAgent(env)
    stubNetwork({ pullFailure: () => new TypeError('fetch failed') })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const outcomes: AgentDeliverOutcomeInput[] = []
      const { result, commandClient } = await runDeliverTick(env, async () => 'accepted', outcomes, {
        commandCreatedAt: new Date().toISOString(),
      })

      expect(result.commands).toMatchObject([{ commandId: FENCED_COMMAND_ID, status: 'held' }])
      expect(commandClient.row(FENCED_COMMAND_ID)).toMatchObject({ status: 'pending' })
      expect(outcomes).toEqual([])
    } finally {
      warn.mockRestore()
    }
  })

  test('记录自身失败 → best-effort 告警,不影响命令 done', async () => {
    const env = await isolatedGuguEnv('gugu-2175-streak-record-down-')
    await seedAgent(env)
    stubNetwork({ unreadRows: () => [unreadRow()] })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const outcomes: AgentDeliverOutcomeInput[] = []
      const { result } = await runDeliverTick(env, async () => 'accepted', outcomes, {
        recordDeliverOutcome: async () => {
          throw new Error('outcome rpc down')
        },
      })

      expect(result.commands).toMatchObject([{ commandId: FENCED_COMMAND_ID, status: 'done' }])
      // fire-and-forget 的 catch 在微任务里落地,冲一拍再断言告警可见(fail-loud 可 grep)。
      await new Promise((resolve) => setImmediate(resolve))
      expect(
        warnSpy.mock.calls.some((args) => args.some((a) => String(a).includes('#2175 deliver outcome record failed'))),
      ).toBe(true)
    } finally {
      warnSpy.mockRestore()
    }
  })
})
