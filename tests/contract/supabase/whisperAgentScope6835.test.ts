/** #6835 悄悄话对 agent 的可见域,对着迁移完的真库:MCP 这一侧的真 handler(message_history / message_search)
 * + 库那一侧的 chat.message_history_as / message_search_as。MCP 拿的是主人的 JWT(主人看得见寄给主人的悄悄话),
 * 可见域必须按 agent 本人判:同一主人名下两个 agent,A 收到的悄悄话 B 读不到、搜不到,A 自己读得到;
 * 发给主人本人的悄悄话,两个 agent 都看不到;不透露「这里有一条悄悄话」(不留占位)。
 * 每条用例 BEGIN…ROLLBACK;loopback 护栏防止它碰共享库/生产库。
 */
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
// @ts-expect-error — 注入式 MCP server 是无类型 .mjs;运行时 import 可用。
import { callTool, RpcHttpError } from '../../../apps/desktop/electron/mcp/gugu-im-server.mjs'

interface DatabaseClient {
  connect(): Promise<void>
  end(): Promise<void>
  query<Row = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: Row[]; fields: Array<{ name: string }> }>
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
    throw new Error('whisperAgentScope6835 requires loopback PostgreSQL')
  }
  db = new Client({ connectionString })
  await db.connect()
})
afterAll(async () => { await db?.end() })
beforeEach(async () => { await db.query('BEGIN') })
afterEach(async () => {
  if (!db) return
  try {
    await db.query('RESET role')
    await db.query('SET CONSTRAINTS ALL IMMEDIATE')
  } finally {
    await db.query('ROLLBACK')
  }
})

async function asUser(id: string): Promise<void> {
  await db.query('SET LOCAL role TO authenticated')
  await db.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: id, role: 'authenticated' })])
}

interface Room { owner: string; peer: string; a: string; b: string; group: string }
async function room(): Promise<Room> {
  const r: Room = { owner: randomUUID(), peer: randomUUID(), a: randomUUID(), b: randomUUID(), group: randomUUID() }
  for (const human of [r.owner, r.peer]) {
    await db.query(`INSERT INTO auth.users (id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
      VALUES ($1,'authenticated','authenticated',$2,'{}','{}',now(),now())`, [human, `${human}@6835.example.invalid`])
    await db.query(`INSERT INTO identity.users (id,type,display_name) VALUES ($1,'human','6835 human')
      ON CONFLICT (id) DO UPDATE SET display_name=EXCLUDED.display_name`, [human])
  }
  await db.query(`INSERT INTO identity.gugu_devices (device_id,user_id,label,hostname,platform)
    VALUES ($1,$2,'6835','6835','darwin')`, [`dev-${r.owner}`, r.owner])
  for (const agent of [r.a, r.b]) {
    await db.query(`INSERT INTO identity.users (id,type,display_name,owner_user_id,device_id)
      VALUES ($1,'agent','6835 agent',$2,$3)`, [agent, r.owner, `dev-${r.owner}`])
  }
  await db.query(`INSERT INTO chat.chats (id,kind,name,creator_user_id) VALUES ($1,'group','6835 group',$2)`, [r.group, r.owner])
  await db.query(`INSERT INTO chat.chat_members (chat_id,user_id,role) VALUES ($1,$2,'owner'),($1,$3,'member'),($1,$4,'member'),($1,$5,'member')`,
    [r.group, r.owner, r.peer, r.a, r.b])
  return r
}
async function post(r: Room, content: string, whisperTo: string | null): Promise<string> {
  const id = randomUUID()
  await db.query(`INSERT INTO chat.messages (id,chat_id,sender_user_id,content,content_type,to_user_ids,is_whisper)
    VALUES ($1,$2,$3,$4,'text',$5,$6)`, [id, r.group, r.peer, content, whisperTo ? [whisperTo] : null, whisperTo !== null])
  return id
}

/** 以主人 JWT 走 PostgREST /rpc 同一判权上下文;agentId 决定 MCP 这一侧「我是谁」。 */
function toolsAs(r: Room, agentId: string) {
  const context = {
    supabaseUrl: '',
    anonKey: '',
    agentId,
    threadRootId: null,
    guguHome: '/tmp/gugu-6835-contract',
    getAccessToken: async () => `x.${Buffer.from(JSON.stringify({ sub: r.owner })).toString('base64url')}.x`,
  }
  const deps = {
    restRpc: async (name: string, body: Record<string, unknown>, profile = 'chat') => {
      if (!/^[a-z_]+$/.test(name) || !/^[a-z_]+$/.test(profile)) throw new Error(`bad rpc name ${profile}.${name}`)
      const keys = Object.keys(body)
      for (const key of keys) if (!/^p_[a-z_]+$/.test(key)) throw new Error(`bad rpc argument ${key}`)
      await db.query('SAVEPOINT rpc_call')
      try {
        await asUser(r.owner)
        const result = await db.query(
          `SELECT * FROM ${profile}.${name}(${keys.map((key, index) => `${key} => $${index + 1}`).join(', ')})`,
          keys.map((key) => body[key]),
        )
        await db.query('RESET role')
        await db.query('RELEASE SAVEPOINT rpc_call')
        const scalar = result.fields.length === 1 && result.fields[0]!.name === name
        return scalar ? result.rows[0]?.[name] ?? null : result.rows
      } catch (error) {
        await db.query('ROLLBACK TO SAVEPOINT rpc_call')
        await db.query('RESET role')
        throw new RpcHttpError(400, { detail: String((error as Error).message) })
      }
    },
    restGet: async (path: string) => { throw new Error(`history and search must not read tables with the owner's token: ${path}`) },
  }
  const read = async (name: 'message_history' | 'message_search', args: Record<string, unknown> = {}) =>
    (JSON.parse(String(await callTool(context, name, { chat_id: r.group, ...args }, deps))) as Array<{ id: string; content: string }>)
  return { read }
}

describe('#6835 whispers in an agent\'s own view, against the migrated database', () => {
  it('A reads and finds its own whisper; B, under the same owner, neither reads nor finds it; nobody sees the owner\'s', async () => {
    const r = await room()
    const open = await post(r, 'psst 6835 everyone', null)
    const toA = await post(r, 'psst 6835 for A', r.a)
    const toOwner = await post(r, 'psst 6835 for the owner', r.owner)

    const a = toolsAs(r, r.a)
    const b = toolsAs(r, r.b)
    // 工具对外给 typed id(msg:<uuid>)。
    const ids = (rows: Array<{ id: string }>) => rows.map((row) => row.id).sort()
    const typed = (...raw: string[]) => raw.map((id) => `msg:${id}`).sort()
    expect(ids(await a.read('message_history'))).toEqual(typed(open, toA))
    expect(ids(await b.read('message_history'))).toEqual(typed(open))
    expect(ids(await a.read('message_search', { query: 'psst 6835' }))).toEqual(typed(open, toA))
    expect(ids(await b.read('message_search', { query: 'psst 6835' }))).toEqual(typed(open))
    // 不留占位、不透露:B 的结果里连那几条的 id 都没有。
    for (const hidden of [toA, toOwner]) expect(JSON.stringify(await b.read('message_history'))).not.toContain(hidden)
    expect(JSON.stringify(await a.read('message_history'))).not.toContain(toOwner)
  })

  // 阳控:三行都在库里(上面的「看不见」不是空表);主人自己的令牌看得见公开那条和寄给他的那条 ——
  // 寄给主人的那条正是「主人看得见、agent 看不见」的一格。
  it('阳控:all three rows exist, and the owner\'s own token sees the open line and the one whispered to the owner', async () => {
    const r = await room()
    const open = await post(r, 'psst 6835 everyone', null)
    await post(r, 'psst 6835 for A', r.a)
    const toOwner = await post(r, 'psst 6835 for the owner', r.owner)
    const { rows: all } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM chat.messages WHERE chat_id = $1`, [r.group])
    expect(all[0]!.n).toBe(3)
    await asUser(r.owner)
    const { rows } = await db.query<{ id: string }>(`SELECT id FROM chat.messages_view WHERE chat_id = $1`, [r.group])
    await db.query('RESET role')
    expect(rows.map((row) => row.id).sort()).toEqual([open, toOwner].sort())
  })
})
