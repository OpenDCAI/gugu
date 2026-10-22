/** #6448 客户端 ↔ 库:agent 状态读数随 presence 行上云。
 * 真相源在客户端(词表、设备 runtime 的发布投影、上报函数的参数名、载荷解析),被判的一半在 gugu-supabase
 * (set_agent_runtime_state 的签名、两列与 CHECK、presence 载荷)。用客户端**真的**上报函数产出的参数,按名调
 * 迁移完的库;再用客户端**真的**解析器读回载荷 —— 任何一边改了名字或词,这里当场红。每个用例回滚,只连 loopback。
 */
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAgentRuntimeStateReporter } from '@gugu/core/cloud/agentRuntimeStateReporter'
import { parseAgentPresencePayload } from '@gugu/core/cloud/agentPresenceProtocol'
import { publishedStatusOf } from '@gugu/core/cloud/deviceRuntimeSweep'
import type { AgentStatusReading } from '@gugu/core/shared/agentStatus'

interface DatabaseClient {
  connect(): Promise<void>
  end(): Promise<void>
  query<Row = never>(sql: string, values?: unknown[]): Promise<{ rows: Row[] }>
}
const { Client } = createRequire(import.meta.url)('pg') as {
  Client: new (config: { connectionString: string }) => DatabaseClient
}
const connectionString = (process.env.GUGU_INTEGRATION_DATABASE_URL ?? '').trim()
let db: DatabaseClient
beforeAll(async () => {
  const target = new URL(connectionString)
  if (!['postgres:', 'postgresql:'].includes(target.protocol)
    || !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)) {
    throw new Error('agentStatusPresence6448 requires loopback PostgreSQL')
  }
  db = new Client({ connectionString })
  await db.connect()
})
afterAll(async () => { await db?.end() })

async function rollback(body: (ids: { owner: string; agent: string }) => Promise<void>): Promise<void> {
  const ids = { owner: randomUUID(), agent: randomUUID() }
  const device = randomUUID()
  await db.query('BEGIN')
  try {
    await db.query(`INSERT INTO auth.users (id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
      VALUES ($1,'authenticated','authenticated',$2,'{}','{}',now(),now())`, [ids.owner, `${ids.owner}@6448.example.invalid`])
    await db.query(`INSERT INTO identity.users (id,type,display_name) VALUES ($1,'human','6448 owner')
      ON CONFLICT (id) DO UPDATE SET display_name=EXCLUDED.display_name`, [ids.owner])
    await db.query(`INSERT INTO identity.gugu_devices (device_id,user_id,label,hostname,platform,status)
      VALUES ($1,$2,'6448','6448','darwin','online')`, [device, ids.owner])
    await db.query(`INSERT INTO identity.users (id,type,display_name,owner_user_id,device_id,desired_status)
      VALUES ($1,'agent','6448 agent',$2,$3,'online')`, [ids.agent, ids.owner, device])
    await body(ids)
  } finally { await db.query('ROLLBACK') }
}

/** 按名调 RPC:参数名就是客户端上报函数写下的那些键(库里少一个名字就报 function does not exist)。 */
function ownerRpcClient(owner: string) {
  return {
    rpc: async (fn: 'set_agent_runtime_state', args: Record<string, unknown>) => {
      const names = Object.keys(args)
      const sql = `SELECT identity.${fn}(${names.map((name, index) => `${name} => $${index + 1}`).join(', ')})`
      await db.query('SAVEPOINT rpc')
      try {
        await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: owner, role: 'authenticated' })])
        await db.query('SET LOCAL ROLE authenticated')
        await db.query(sql, names.map((name) => args[name]))
        await db.query('RESET ROLE')
        await db.query('RELEASE SAVEPOINT rpc')
        return { error: null }
      } catch (error) {
        await db.query('ROLLBACK TO SAVEPOINT rpc')
        return { error: { message: (error as Error).message } }
      }
    },
  }
}

async function readPresence(agent: string) {
  const { rows } = await db.query<{ payload: unknown }>('SELECT identity.build_agent_presence_payload($1) AS payload', [agent])
  const payload = parseAgentPresencePayload(rows[0]?.payload)
  if (!payload) throw new Error('presence payload did not parse on the client')
  return payload
}

const reading = (status: AgentStatusReading['status'], detail: AgentStatusReading['detail']): AgentStatusReading => ({
  status,
  detail,
  running: status === 'needs_user' || (status === 'working' && detail === 'running'),
  background: detail === 'parked' ? 'running' : null,
})

describe('#6448 agent status reading on the presence row', () => {
  it.each([
    reading('needs_user', 'question'),
    reading('working', 'parked'),
    reading('idle', 'done'),
    reading('error', null),
  ])('the device runtime publishes %o and every other client reads the same reading back', async (r) => rollback(async ({ owner, agent }) => {
    const report = createAgentRuntimeStateReporter(ownerRpcClient(owner))
    const published = publishedStatusOf(r)
    await report({
      agentUserId: agent,
      activityStatus: published.activityStatus,
      agentStatus: published.reading?.status ?? null,
      agentStatusDetail: published.reading?.detail ?? null,
      runtimeKind: 'gugu',
      runtimeLabel: '6448-host',
    })
    const presence = await readPresence(agent)
    expect(presence.status).toEqual({ status: r.status, detail: r.detail })
    expect(presence.activityStatus, '老客户端读的 running/idle 投影').toBe(r.status === 'working' || r.status === 'needs_user' ? 'running' : 'idle')
  }))

  it('a write that cannot state a reading (an offline write) clears it; readers fall back to the projection', async () => rollback(async ({ owner, agent }) => {
    const report = createAgentRuntimeStateReporter(ownerRpcClient(owner))
    await report({ agentUserId: agent, activityStatus: 'running', agentStatus: 'working', agentStatusDetail: 'running', runtimeKind: 'gugu', runtimeLabel: 'h' })
    await report({ agentUserId: agent, activityStatus: 'idle', runtimeKind: 'gugu', runtimeLabel: 'h' })
    const presence = await readPresence(agent)
    expect(presence.status).toBeNull()
    expect(presence.activityStatus).toBe('idle')
  }))
})
