/** #7233 客户端 ↔ 库:设备 RPC「一个发问端一条线」的 topic 要被 realtime.messages 的 RLS 放行。
 * 真相源在客户端(deviceRpcAskerChannelName 造出来的 `gugu:<dev>:rpc:<asker>`),被判的一半在 gugu-supabase
 * (gugu_rpc_events_select / gugu_rpc_events_insert:只看前三段 —— gugu、本账号名下的设备、rpc)。这里取迁移完的库里**真的**
 * 那两条策略的表达式,以 authenticated 角色、带上 JWT,对客户端造出来的 topic 求值:主人能读能写,别的账号、别人的设备不能。
 * 库那边要是把策略收紧成只认三段,这里当场红。每个用例回滚,只连 loopback。
 */
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { deviceRpcAskerChannelName, deviceRpcChannelName } from '@gugu/core/cloud/deviceRpcProtocol'

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
    throw new Error('deviceRpcAskerTopic7233 requires loopback PostgreSQL')
  }
  db = new Client({ connectionString })
  await db.connect()
})
afterAll(async () => { await db?.end() })

type Fixture = { owner: string; other: string; device: string; otherDevice: string }

async function rollback(body: (ids: Fixture) => Promise<void>): Promise<void> {
  const ids: Fixture = { owner: randomUUID(), other: randomUUID(), device: randomUUID(), otherDevice: randomUUID() }
  await db.query('BEGIN')
  try {
    for (const [user, device] of [[ids.owner, ids.device], [ids.other, ids.otherDevice]] as const) {
      await db.query(`INSERT INTO auth.users (id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
        VALUES ($1,'authenticated','authenticated',$2,'{}','{}',now(),now())`, [user, `${user}@7233.example.invalid`])
      await db.query(`INSERT INTO identity.users (id,type,display_name) VALUES ($1,'human','7233')
        ON CONFLICT (id) DO UPDATE SET display_name=EXCLUDED.display_name`, [user])
      await db.query(`INSERT INTO identity.gugu_devices (device_id,user_id,label,hostname,platform,status)
        VALUES ($1,$2,'7233','7233','darwin','online')`, [device, user])
    }
    await body(ids)
  } finally { await db.query('ROLLBACK') }
}

/** 迁移完的库里那条策略的表达式(SELECT 取 USING,INSERT 取 WITH CHECK)。 */
async function policyExpression(name: 'gugu_rpc_events_select' | 'gugu_rpc_events_insert'): Promise<string> {
  const { rows } = await db.query<{ qual: string | null; with_check: string | null }>(
    `SELECT qual, with_check FROM pg_policies WHERE schemaname = 'realtime' AND tablename = 'messages' AND policyname = $1`,
    [name],
  )
  const expression = name === 'gugu_rpc_events_select' ? rows[0]?.qual : rows[0]?.with_check
  if (!expression) throw new Error(`policy ${name} is missing on realtime.messages`)
  return expression
}

/** 以 `user` 的身份(authenticated + JWT)对一条 topic 求那条策略的值。 */
async function allowed(expression: string, user: string, topic: string): Promise<boolean> {
  await db.query('SAVEPOINT probe')
  try {
    await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: user, role: 'authenticated' })])
    await db.query('SET LOCAL ROLE authenticated')
    const { rows } = await db.query<{ allowed: boolean }>(`SELECT (${expression}) AS allowed FROM (SELECT $1::text AS topic) AS messages`, [topic])
    return rows[0]?.allowed === true
  } finally {
    await db.query('ROLLBACK TO SAVEPOINT probe')
  }
}

describe('#7233 设备 RPC 发问端自己那条 topic 过得了 realtime.messages 的 RLS', () => {
  for (const policy of ['gugu_rpc_events_select', 'gugu_rpc_events_insert'] as const) {
    it(`${policy}:主人的四段 topic 放行;别的账号、别人的设备不放行(对照:三段的共用 topic 同样)`, async () => {
      const expression = await policyExpression(policy)
      await rollback(async ({ owner, other, device, otherDevice }) => {
        const mine = deviceRpcAskerChannelName(device, 'askerAAAA1111')
        expect(mine).toBe(`gugu:${device}:rpc:askerAAAA1111`)
        expect(await allowed(expression, owner, mine)).toBe(true)
        expect(await allowed(expression, other, mine)).toBe(false)
        expect(await allowed(expression, owner, deviceRpcAskerChannelName(otherDevice, 'askerAAAA1111'))).toBe(false)
        expect(await allowed(expression, owner, deviceRpcChannelName(device))).toBe(true)
        expect(await allowed(expression, other, deviceRpcChannelName(device))).toBe(false)
      })
    })
  }
})
