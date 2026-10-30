import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect } from 'vitest'
import {
  createAgent,
  updateAgent,
  type CommandRunOptions,
  type CommandRunResult,
  type DeviceCommandTableClient,
  type DeviceHeartbeatTableClient,
} from '@gugu/core'

export async function isolatedHome(prefix: string): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix))
}

export async function isolatedGuguEnv(
  prefix: string,
  overrides: NodeJS.ProcessEnv = {}
): Promise<NodeJS.ProcessEnv> {
  const home = await isolatedHome(prefix)
  return { HOME: home, GUGU_HOME: join(home, '.state'), ...overrides }
}

export const TEST_AGENT_USER_ID = 'agent-user-1'
const TEST_AGENT_NAME = 'Chloe'
const TEST_AGENT_TYPE = 'codex'
const TEST_AGENT_PATH = '/repo'
const TEST_CHAT_ID = 'chat-1'
const TEST_MESSAGE_ID = 'msg-1'
const TEST_SENDER_USER_ID = 'owner-1'
const TEST_MESSAGE_CONTENT = 'please continue'
const TEST_GREETING_CHAT_ID = 'chat-1234567890'

export const TEST_AGENT_CREATE_PAYLOAD = {
  agent_user_id: TEST_AGENT_USER_ID,
  display_name: TEST_AGENT_NAME,
  agent_type: TEST_AGENT_TYPE,
  project_path: TEST_AGENT_PATH,
  greeting_chat_id: TEST_GREETING_CHAT_ID
}

export const TEST_AGENT_DELIVER_PAYLOAD = {
  agent_user_id: TEST_AGENT_USER_ID,
  chat_id: TEST_CHAT_ID,
  message_id: TEST_MESSAGE_ID,
  sender_user_id: TEST_SENDER_USER_ID,
  content: TEST_MESSAGE_CONTENT,
  // #857: a directed delivery to this agent (the common DM/@ case). Matches the real device-command
  // payload (migration 20260615050000 forwards to_user_ids/is_whisper) and hard-triggers so delivery
  // is mode-independent — these tests exercise delivery mechanics, not the listen-mode gate (which has
  // its own suite). Without it, the adaptive gate skips (no LLM in unit env) and delivery never runs.
  to_user_ids: [TEST_AGENT_USER_ID],
  is_whisper: true
}

export function testAgentCreatePayload(overrides: Record<string, unknown> = {}) {
  return { ...TEST_AGENT_CREATE_PAYLOAD, ...overrides }
}

export function testAgentDeliverPayload(overrides: Record<string, unknown> = {}) {
  return { ...TEST_AGENT_DELIVER_PAYLOAD, ...overrides }
}

export const captureRuntimeReport =
  (runtimeReports: unknown[]) =>
  async (state: unknown): Promise<void> => {
    runtimeReports.push(state)
  }

export async function createTestLocalAgent(
  env: NodeJS.ProcessEnv,
  input: Partial<Parameters<typeof createAgent>[0]> = {},
  patch?: Parameters<typeof updateAgent>[1]
) {
  const agent = await createAgent(
    {
      name: TEST_AGENT_NAME,
      agent_type: TEST_AGENT_TYPE,
      path: TEST_AGENT_PATH,
      gugu_user_id: TEST_AGENT_USER_ID,
      ...input
    },
    env
  )
  if (patch) await updateAgent({ guguUserId: agent.gugu_user_id }, patch, env)
  return agent
}

export async function createTestLocalAgentWithoutPath(
  env: NodeJS.ProcessEnv,
  patch?: Parameters<typeof updateAgent>[1]
) {
  const agent = await createAgent(
    {
      name: TEST_AGENT_NAME,
      agent_type: TEST_AGENT_TYPE,
      gugu_user_id: TEST_AGENT_USER_ID
    },
    env
  )
  if (patch) await updateAgent({ guguUserId: agent.gugu_user_id }, patch, env)
  return agent
}

export function expectedDeliveredMessage(
  targetId: string,
  content = TEST_MESSAGE_CONTENT,
  chatId = TEST_CHAT_ID,
  reply?: { messageId: string; senderUserId: string; preview: string },
  timestamp = 'TIMESTAMP'
) {
  const head = [
    `Gugu msg from 咕咕号 ${TEST_SENDER_USER_ID} in 群号 ${chatId}, seq ${TEST_MESSAGE_ID} [${timestamp}]`,
  ]
  if (reply) {
    head.push(`Reply to 咕咕号 ${reply.senderUserId}: ${reply.preview}`)
  }
  head.push(`Reply with gugu send chat:${chatId} --to ${TEST_SENDER_USER_ID} --reply-to ${TEST_MESSAGE_ID} "your reply"`)
  return {
    targetId,
    text: `${head.join('\n')}\n\n${content}`
  }
}

export type RecordedCommandCall =
  | { kind: 'run'; args: string[]; options?: CommandRunOptions }
  | { kind: 'checkOutput'; args: string[] }
  | { kind: 'sleep'; seconds: number }
  | { kind: 'rpc'; method: string; params?: Record<string, unknown> }

export class RecordingCommandRunner {
  readonly calls: RecordedCommandCall[] = []
  runResults: CommandRunResult[] = []
  outputs: string[] = []

  async run(args: string[], options?: CommandRunOptions): Promise<CommandRunResult> {
    this.calls.push({ kind: 'run', args, options })
    return this.runResults.shift() ?? { status: 0, stdout: '', stderr: '' }
  }

  async checkOutput(args: string[]): Promise<string> {
    this.calls.push({ kind: 'checkOutput', args })
    return this.outputs.shift() ?? ''
  }

  async sleep(seconds: number): Promise<void> {
    this.calls.push({ kind: 'sleep', seconds })
  }
}

export type MemoryCommandRow = Record<string, unknown> & { id: string }

export function deviceCommandRow(input: {
  id?: string
  userId?: string
  deviceId: string
  type: string
  payload: Record<string, unknown>
  createdAt?: string
}): MemoryCommandRow {
  const row: MemoryCommandRow = {
    id: input.id ?? 'cmd-1',
    device_id: input.deviceId,
    type: input.type,
    status: 'pending',
    payload: input.payload,
    created_at: input.createdAt ?? '2026-05-21T00:00:00.000Z'
  }
  if (input.userId) row.user_id = input.userId
  return row
}

export type MemoryCommandClientOptions = {
  compare?: 'string' | 'strict'
  insertError?: string
  singleError?: string
  /** #5041 — 心跳登记用的时钟(runtime_instances.last_heartbeat_at);缺省 = 墙钟。 */
  nowIso?: () => string
}

export class MemoryHeartbeatClient implements DeviceHeartbeatTableClient {
  upserts: Array<{ row: Record<string, unknown>; options?: { onConflict: string } }> = []
  /** #156 退出时标成离线的那几次:设备 id + 写进去的值。 */
  offlineUpdates: Array<{ deviceId: string; value: { status: 'offline'; updated_at: string } }> = []
  cleanupCalls: Record<string, unknown>[] = []
  rows: Array<{ device_id: string; user_id: string; hostname: string; machine_id?: string | null; tier?: string | null }> = []

  constructor(private errorMessage: string | null = null) {}

  from(table: 'gugu_devices') {
    expect(table).toBe('gugu_devices')
    return {
      upsert: (row: never, options?: { onConflict: string }) => {
        const result = this.errorMessage ? { data: null, error: { message: this.errorMessage } } : { data: null, error: null }
        if (!this.errorMessage) this.upserts.push({ row: row as Record<string, unknown>, options })
        return Object.assign(Promise.resolve(result), {
          select: async () => ({ ...result, data: result.error ? null : [{ runtimes: [] }] }),
        })
      },
      update: (value: { status: 'online' | 'offline'; updated_at: string }) => ({
        eq: (_column: 'device_id', deviceId: string) => {
          const error = this.errorMessage ? { message: this.errorMessage } : null
          if (!error && value.status === 'offline') this.offlineUpdates.push({ deviceId, value: { ...value, status: 'offline' } })
          return Object.assign(Promise.resolve({ error }), {
            select: async () => ({ error, data: error ? null : [{ runtimes: [] }] }),
          })
        },
      }),
      select: (_columns: string) => ({
        eq: (_userColumn: 'user_id', userValue: string) => ({
          eq: (_machineColumn: 'machine_id', machineValue: string) => ({
            order: async () => ({
              data: this.rows
                .filter((r) => r.user_id === userValue && r.machine_id === machineValue)
                .map((r) => ({ device_id: r.device_id, tier: r.tier ?? 'production' })),
              error: null,
            }),
            eq: (_tierColumn: 'tier', tierValue: string) => ({
              limit: (_n: number) => ({
                maybeSingle: async () => {
                  const match = this.rows.find(
                    (r) =>
                      r.user_id === userValue &&
                      r.machine_id === machineValue &&
                      (r.tier ?? 'production') === tierValue,
                  )
                  return match
                    ? { data: { device_id: match.device_id }, error: null }
                    : { data: null, error: null }
                },
              }),
            }),
          }),
        }),
      }),
    }
  }

  async rpc(fn: 'cleanup_legacy_gugu_devices', args: Record<string, unknown>) {
    expect(fn).toBe('cleanup_legacy_gugu_devices')
    this.cleanupCalls.push(args)
    return { error: null }
  }
}

// @@@1600 — 模拟 identity.fetch_fair_pending_device_commands(与迁移 SQL 同语义,供单测覆盖跨 agent 公平):
// device+pending 过滤 → 按 COALESCE(payload.agent_user_id, id) 分组(等价 deviceCommandOrderingKey)→ 组内
// created_at ASC(id 兜底)取前 perAgent → 整体 created_at ASC。真值由迁移 dry-run 实证,本 sim 让 dispatcher
// 测试能验证「busy agent 不饿死他 agent + agent 内 FIFO」。
export function simulateFairPendingFetch(
  rows: MemoryCommandRow[],
  args: Record<string, unknown>
): { data: unknown[]; error: null } {
  const deviceId = String(args.p_device_id ?? '')
  const perAgent = Math.max(Number(args.p_per_agent ?? 1), 1)
  const pending = rows.filter((r) => r.device_id === deviceId && r.status === 'pending')
  const groups = new Map<string, MemoryCommandRow[]>()
  for (const r of pending) {
    const payload = r.payload as { agent_user_id?: unknown } | undefined
    const agentId = payload && typeof payload === 'object' ? payload.agent_user_id : undefined
    const key = typeof agentId === 'string' && agentId.length > 0 ? `agent:${agentId}` : `cmd:${r.id}`
    const arr = groups.get(key)
    if (arr) arr.push(r)
    else groups.set(key, [r])
  }
  const cmp = (a: MemoryCommandRow, b: MemoryCommandRow): number => {
    const c = String(a.created_at ?? '').localeCompare(String(b.created_at ?? ''))
    return c !== 0 ? c : String(a.id).localeCompare(String(b.id))
  }
  const picked: MemoryCommandRow[] = []
  for (const arr of groups.values()) picked.push(...[...arr].sort(cmp).slice(0, perAgent))
  picked.sort(cmp)
  return { data: picked, error: null }
}

// @@@1676 — 模拟 identity.recover_orphaned_device_commands(与迁移 SQL 同语义,供单测覆盖多实例)：
// device 匹配 + status='running' + 持有实例为空(legacy)或不在「活实例集」(心跳过期/缺失) → 重置 pending。
// 活实例集由 runtime_instance_heartbeat 维护(见下)。真值由迁移 dry-run 实证;本 sim 让 tick 测试能验证
// 「活兄弟在途命令不被清、死实例孤儿被回收」。
export function simulateRecoverOrphaned(
  rows: MemoryCommandRow[],
  args: Record<string, unknown>,
  liveInstances: ReadonlySet<string>
): { data: number; error: null } {
  const deviceId = String(args.p_device_id ?? '')
  let count = 0
  for (const r of rows) {
    if (r.device_id !== deviceId || r.status !== 'running') continue
    const claimedBy = typeof r.claimed_by === 'string' ? r.claimed_by : null
    if (claimedBy && liveInstances.has(claimedBy)) continue
    r.status = 'pending'
    r.claimed_at = null
    r.claimed_by = null
    r.claim_token = null
    count += 1
  }
  return { data: count, error: null }
}

export type MemoryRuntimeInstanceRow = { instance_id: string; device_id: string; last_heartbeat_at: string }

export class MemoryDeviceCommandClient implements DeviceCommandTableClient {
  // @@@1676 — runtime_instance_heartbeat 注册的活实例集(无时钟,登记即视为活;孤儿回收据此判活)。
  protected liveInstances = new Set<string>()
  // #5041 — identity.runtime_instances 行(带心跳时刻),持有判据据此判兄弟活/死。
  protected runtimeInstances = new Map<string, MemoryRuntimeInstanceRow>()

  /** #5041 — 直接登记一个(兄弟)实例的心跳行,模拟另一个进程的 heartbeat。 */
  setRuntimeInstance(instanceId: string, deviceId: string, lastHeartbeatAt: string): void {
    this.liveInstances.add(instanceId)
    this.runtimeInstances.set(instanceId, { instance_id: instanceId, device_id: deviceId, last_heartbeat_at: lastHeartbeatAt })
  }

  protected recordHeartbeat(args: Record<string, unknown>): void {
    const instanceId = String(args.p_instance_id ?? '')
    this.liveInstances.add(instanceId)
    this.runtimeInstances.set(instanceId, {
      instance_id: instanceId,
      device_id: String(args.p_device_id ?? ''),
      last_heartbeat_at: this.options.nowIso?.() ?? new Date().toISOString(),
    })
  }

  async rpc(fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { message: string } | null }> {
    if (fn === 'fetch_fair_pending_device_commands') return simulateFairPendingFetch(this.rows, args)
    if (fn === 'runtime_instance_heartbeat') {
      this.recordHeartbeat(args)
      // @@@5912 这条 RPC 顺路把「设备租约清扫者上一次跑过多久了」捎回来。
      // 假库模拟的是一个**健康**的库 ⇒ 0 秒。要测宿主怎么报故障,用例自己覆盖这个返回值。
      return { data: { device_lease_sweep_age_seconds: 0 }, error: null }
    }
    if (fn === 'recover_orphaned_device_commands') return simulateRecoverOrphaned(this.rows, args, this.liveInstances)
    if (fn === 'recheck_device_command_execution') {
      const row = this.rows.find((candidate) => candidate.id === args.p_id)
      return {
        data: Boolean(
          row && row.status === 'running' && row.claim_token === args.p_claim_token
        ),
        error: null,
      }
    }
    throw new Error(`MemoryDeviceCommandClient: unexpected rpc ${fn}`)
  }

  constructor(
    protected rows: MemoryCommandRow[],
    protected options: MemoryCommandClientOptions = {}
  ) {}

  add(row: MemoryCommandRow): void {
    this.rows.push(row)
  }

  row(id: string): MemoryCommandRow {
    const row = this.rows.find((item) => item.id === id)
    if (!row) throw new Error(`missing row ${id}`)
    return row
  }

  rowsWithType(type: string): MemoryCommandRow[] {
    return this.rows.filter((item) => item.type === type)
  }

  from(table: 'gugu_device_commands'): MemoryDeviceCommandTable
  from(table: 'runtime_instances'): MemoryRuntimeInstanceTable
  from(table: 'gugu_device_commands' | 'runtime_instances'): MemoryDeviceCommandTable | MemoryRuntimeInstanceTable {
    if (table === 'runtime_instances') return new MemoryRuntimeInstanceTable(this.runtimeInstances, this.liveInstances)
    expect(table).toBe('gugu_device_commands')
    return new MemoryDeviceCommandTable(this.rows, this.options)
  }
}

/** #5041 — runtime_instances 表:select(...).eq(...) 直接 await 出行;#156 停机时 delete().eq('instance_id') 删自己那一行。 */
export class MemoryRuntimeInstanceTable {
  constructor(private instances: Map<string, MemoryRuntimeInstanceRow>, private live?: Set<string>) {}

  delete() {
    return {
      eq: async (_column: 'instance_id', instanceId: string) => {
        this.instances.delete(instanceId)
        this.live?.delete(instanceId)
        return { data: null, error: null }
      },
    }
  }

  select(columns: string) {
    const filters: [string, string][] = []
    const rows = () => [...this.instances.values()]
      .filter((row) => filters.every(([column, value]) => String((row as Record<string, unknown>)[column] ?? '') === value))
      .map((row) => projectRow(row as Record<string, unknown>, columns))
    const builder = {
      eq(column: string, value: string) { filters.push([column, value]); return builder },
      then<TResult1 = { data: unknown[]; error: null }, TResult2 = never>(
        onfulfilled?: ((value: { data: unknown[]; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
      ): PromiseLike<TResult1 | TResult2> {
        return Promise.resolve({ data: rows(), error: null }).then(onfulfilled ?? undefined, onrejected ?? undefined)
      },
    }
    return builder
  }
}

export class MemoryRuntimeIdentityClient
  extends MemoryDeviceCommandClient
{
  upserts: Array<{ row: Record<string, unknown>; options?: { onConflict: string } }> = []
  /** #156 退出时标成离线的那几次:设备 id + 写进去的值。 */
  offlineUpdates: Array<{ deviceId: string; value: { status: 'offline'; updated_at: string } }> = []
  cleanupCalls: Record<string, unknown>[] = []
  runtimeStateCalls: Record<string, unknown>[] = []
  markReadCalls: Record<string, unknown>[] = []
  /** `get_agent_presence_batch` 的次数与云端那一行:没登记的 id 回一行「在、空闲、没有读数」。 */
  presenceBatchCalls = 0
  presence = new Map<string, Record<string, unknown>>()
  /** @@@5912 identity lookup(`GET gugu_devices`)的次数 —— 三刀之二判的就是这个账本。 */
  deviceIdentityLookups = 0
  /** @@@5912 假库里那个清扫者有多久没跑了;用例把它调大来测宿主会不会响亮报故障。 */
  deviceLeaseSweepAgeSeconds: number | null = 0

  from(table: 'gugu_device_commands'): MemoryDeviceCommandTable
  from(table: 'runtime_instances'): MemoryRuntimeInstanceTable
  from(table: 'gugu_devices'): {
    upsert: (row: never, options?: { onConflict: string }) => Promise<{ data: null; error: null }>
    update: (value: { status: 'offline'; updated_at: string }) => { eq: (col: 'device_id', value: string) => Promise<{ error: null }> }
    select: (columns: string) => {
      eq: (col: 'user_id', value: string) => {
        eq: (col: 'machine_id', value: string) => {
          eq: (col: 'tier', value: string) => {
            limit: (n: number) => {
              maybeSingle: () => Promise<{ data: { device_id: string } | null; error: null }>
            }
          }
        }
      }
    }
  }
  from(table: 'gugu_device_commands' | 'gugu_devices' | 'runtime_instances'): unknown {
    if (table === 'runtime_instances') return new MemoryRuntimeInstanceTable(this.runtimeInstances, this.liveInstances)
    if (table === 'gugu_devices') {
      return {
        upsert: async (row: never, options?: { onConflict: string }) => {
          this.upserts.push({ row: row as Record<string, unknown>, options })
          return { data: null, error: null }
        },
        update: (value: { status: 'offline'; updated_at: string }) => ({
          eq: async (_column: 'device_id', deviceId: string) => {
            this.offlineUpdates.push({ deviceId, value })
            return { error: null }
          },
        }),
        // @@@5912 这一条就是 identity lookup(`GET gugu_devices`);数它,三刀之二判的是它的次数。
        select: (_columns: string) => (this.deviceIdentityLookups += 1, {
          eq: (_userColumn: 'user_id', _userValue: string) => ({
            eq: (_machineColumn: 'machine_id', _machineValue: string) => ({
              eq: (_tierColumn: 'tier', _tierValue: string) => ({
                limit: (_n: number) => ({
                  maybeSingle: async () => ({ data: null, error: null }),
                }),
              }),
            }),
          }),
        }),
      }
    }
    return new MemoryDeviceCommandTable(this.rows, this.options)
  }

  async rpc(fn: string, args: Record<string, unknown>) {
    if (fn === 'fetch_fair_pending_device_commands') {
      return simulateFairPendingFetch(this.rows, args)
    } else if (fn === 'cleanup_legacy_gugu_devices') {
      this.cleanupCalls.push(args)
    } else if (fn === 'mark_read_on_deliver') {
      this.markReadCalls.push(args)
    } else if (fn === 'runtime_instance_heartbeat') {
      // @@@1676 — 登记活实例(供 recover_orphaned_device_commands 判活;#5041 持有判据读同一张表的心跳时刻)。
      this.recordHeartbeat(args)
      // @@@5912 健康的库:清扫者刚跑过。
      return { data: { device_lease_sweep_age_seconds: this.deviceLeaseSweepAgeSeconds }, error: null }
    } else if (fn === 'recover_orphaned_device_commands') {
      return simulateRecoverOrphaned(this.rows, args, this.liveInstances)
    } else if (fn === 'recheck_device_command_execution') {
      const row = this.rows.find((candidate) => candidate.id === args.p_id)
      return {
        data: Boolean(
          row && row.status === 'running' && row.claim_token === args.p_claim_token
        ),
        error: null,
      }
    } else if (fn === 'get_agent_presence_batch') {
      this.presenceBatchCalls += 1
      const ids = args.p_agent_user_ids as string[]
      return { data: { results: Object.fromEntries(ids.map((id) => [id, this.presence.get(id) ?? presenceRow(id)])) }, error: null }
    } else {
      expect(fn).toBe('set_agent_runtime_state')
      this.runtimeStateCalls.push(args)
    }
    return { data: null, error: null }
  }
}

/** `get_agent_presence_batch` 的一条 `presence` 结果(与 identity.build_agent_presence_payload 同形),按需覆盖字段。 */
export function presenceRow(agentUserId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: 'presence',
    presence: {
      agent_user_id: agentUserId,
      account_status: 'active',
      desired_status: 'online',
      runtime_status: 'online',
      activity_status: 'idle',
      agent_status: null,
      agent_status_detail: null,
      recent_actions: [],
      last_action_at: null,
      updated_at: '2026-10-22T00:00:00.000Z',
      ...overrides,
    },
  }
}

export function pollOnlyMemoryDeviceCommandClient(
  rows: MemoryCommandRow[],
  label: string
): MemoryDeviceCommandClient {
  return new MemoryDeviceCommandClient(rows, {
    insertError: `insert is not used by ${label}`,
    singleError: `single is not used by ${label}`
  })
}

export function pollOnlyRuntimeIdentityClient(
  rows: MemoryCommandRow[],
  label: string
): MemoryRuntimeIdentityClient {
  return new MemoryRuntimeIdentityClient(rows, {
    insertError: `insert is not used by ${label}`,
    singleError: `single is not used by ${label}`
  })
}

class MemoryDeviceCommandTable {
  constructor(
    private rows: MemoryCommandRow[],
    private options: MemoryCommandClientOptions
  ) {}

  insert(value: never) {
    if (this.options.insertError) throw new Error(this.options.insertError)
    const row = {
      ...(value as Record<string, unknown>),
      id: `cmd-new-${this.rows.length}`,
      status: 'pending'
    }
    this.rows.push(row as MemoryCommandRow)
    return {
      select: (columns: string) => ({
        single: async () => ({ data: projectRow(row, columns), error: null })
      })
    }
  }

  select(columns: string) {
    return new MemorySelectBuilder(this.rows, columns, this.options)
  }

  update(patch: never) {
    return new MemoryUpdateBuilder(this.rows, patch as Record<string, unknown>, this.options)
  }
}

class MemorySelectBuilder {
  private filters: [string, string][] = []

  constructor(
    private rows: MemoryCommandRow[],
    private columns: string,
    private options: MemoryCommandClientOptions
  ) {}

  eq(column: string, value: string): this {
    this.filters.push([column, value])
    return this
  }

  order(column: string, options: { ascending: boolean; nullsFirst?: boolean }) {
    // 镜像 PostgREST/PG:缺省 ASC 时 NULLS LAST、DESC 时 NULLS FIRST;显式 nullsFirst 覆盖。
    const nullsFirst = options.nullsFirst ?? !options.ascending
    return {
      limit: async (count: number) => {
        const sorted = [...this.matching()].sort((left, right) => {
          const l = left[column], r = right[column]
          const lNull = l === null || l === undefined, rNull = r === null || r === undefined
          if (lNull || rNull) {
            if (lNull && rNull) return 0
            return (lNull ? -1 : 1) * (nullsFirst ? 1 : -1)
          }
          const order = String(l).localeCompare(String(r))
          return options.ascending ? order : -order
        })
        return {
          data: sorted.slice(0, count).map((row) => projectRow(row, this.columns)),
          error: null
        }
      }
    }
  }

  async single() {
    if (this.options.singleError) throw new Error(this.options.singleError)
    return { data: projectRow(this.matching()[0], this.columns), error: null }
  }

  // @@@1875 — 镜像 PostgREST .maybeSingle()：0 行回 { data: null } 而非 406 抛错，供 getDeviceCommand 走瞬时容错路径。
  async maybeSingle() {
    if (this.options.singleError) throw new Error(this.options.singleError)
    const first = this.matching()[0]
    return { data: first ? projectRow(first, this.columns) : null, error: null }
  }

  private matching(): MemoryCommandRow[] {
    return this.rows.filter((row) =>
      this.filters.every(([column, value]) => columnMatches(readColumn(row, column), value, this.options.compare))
    )
  }
}

// #5041 — 镜像 PostgREST 的 JSON 路径过滤(`payload->>agent_user_id=eq.X`):`a->>b` 读 row.a[b]。
function readColumn(row: Record<string, unknown>, column: string): unknown {
  const arrow = column.indexOf('->>')
  if (arrow === -1) return row[column]
  const base = row[column.slice(0, arrow)]
  const key = column.slice(arrow + 3)
  return base && typeof base === 'object' ? (base as Record<string, unknown>)[key] : undefined
}

class MemoryUpdateBuilder {
  private filters: [string, string][] = []

  constructor(
    private rows: MemoryCommandRow[],
    private patch: Record<string, unknown>,
    private options: MemoryCommandClientOptions
  ) {}

  eq(column: string, value: string): this {
    this.filters.push([column, value])
    return this
  }

  async select(columns: string) {
    const updated = this.apply()
    return { data: updated.map((row) => projectRow(row, columns)), error: null }
  }

  then<TResult1 = { data: MemoryCommandRow[]; error: null }, TResult2 = never>(
    onfulfilled?:
      | ((value: { data: MemoryCommandRow[]; error: null }) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve({ data: this.apply(), error: null }).then(
      onfulfilled ?? undefined,
      onrejected ?? undefined
    )
  }

  private apply(): MemoryCommandRow[] {
    const updated: MemoryCommandRow[] = []
    for (const row of this.rows) {
      if (this.filters.every(([column, value]) => columnMatches(row[column], value, this.options.compare))) {
        Object.assign(row, this.patch)
        updated.push(row)
      }
    }
    return updated
  }
}

function columnMatches(actual: unknown, expected: string, compare: MemoryCommandClientOptions['compare']): boolean {
  return compare === 'strict' ? actual === expected : String(actual ?? '') === expected
}

function projectRow(row: MemoryCommandRow | Record<string, unknown> | undefined, columns: string): Record<string, unknown> | null {
  if (!row) return null
  if (columns === '*') return { ...row }
  return Object.fromEntries(columns.split(',').map((column) => {
    const key = column.trim()
    return [key, row[key]]
  }))
}
