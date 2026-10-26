/** profile_whoami / message_conversations 对着迁移完的真库:MCP 这一侧的真 handler(callTool)+ 库那一侧的真函数
 * (chat.list_my_chats_as)。RPC 名、参数名、返回形状,两边任一改动都在这里红。
 * restRpc / restGet 以主人身份(authenticated + JWT sub)在同一条连接上执行,与 PostgREST 同一个判权上下文。
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
    throw new Error('whoamiStanding requires loopback PostgreSQL')
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

async function human(name: string): Promise<string> {
  const id = randomUUID()
  await db.query(`INSERT INTO auth.users (id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES ($1,'authenticated','authenticated',$2,'{}','{}',now(),now())`, [id, `${id}@whoami.example.invalid`])
  await db.query(`INSERT INTO identity.users (id,type,display_name) VALUES ($1,'human',$2)
    ON CONFLICT (id) DO UPDATE SET display_name=EXCLUDED.display_name`, [id, name])
  await db.query(`INSERT INTO identity.gugu_devices (device_id,user_id,label,hostname,platform)
    VALUES ($1,$2,'whoami','whoami','darwin')`, [`dev-${id}`, id])
  return id
}
async function agentOf(owner: string, name: string): Promise<string> {
  const id = randomUUID()
  await db.query(`INSERT INTO identity.users (id,type,display_name,owner_user_id,device_id)
    VALUES ($1,'agent',$2,$3,$4)`, [id, name, owner, `dev-${owner}`])
  return id
}
async function asUser(id: string): Promise<void> {
  await db.query('SET LOCAL role TO authenticated')
  await db.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: id, role: 'authenticated' })])
}
async function group(creator: string, name: string, members: Array<[string, string]>): Promise<string> {
  const id = randomUUID()
  await asUser(creator)
  await db.query('SELECT chat.create_gugu_group($1,$2,$3,$4::jsonb)', [
    id, name, creator, '[]',
  ])
  await db.query('RESET role')
  for (const [userId, role] of members) await db.query('INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES ($1,$2,$3)', [id,userId,role])
  return id
}
/** 界面点开私聊走的那条函数(chat.open_dm),以发起人身份。 */
async function dm(from: string, to: string): Promise<string> {
  await asUser(from)
  const { rows } = await db.query<{ id: string }>('SELECT chat.open_dm($1) AS id', [to])
  await db.query('RESET role')
  return rows[0]!.id
}

/** 以 owner 的身份跑一段 SQL(与 PostgREST 带主人 JWT 同一个判权上下文),失败回滚到调用前。 */
/**
 * 用例里只有一条 pg 连接,而工具会并发地发读(message_conversations 同时读会话和主人的置顶)。savepoint / SET LOCAL role
 * 在同一条连接上交错会互相踩 ⇒ 逐个排队执行,真库那边本来就是各自一次 HTTP 请求。
 */
let serial: Promise<unknown> = Promise.resolve()
function asOwnerQuery<Row = Record<string, unknown>>(owner: string, sql: string, values: unknown[]) {
  const run = serial.then(() => asOwnerQueryNow<Row>(owner, sql, values), () => asOwnerQueryNow<Row>(owner, sql, values))
  serial = run.catch(() => undefined)
  return run
}
async function asOwnerQueryNow<Row = Record<string, unknown>>(owner: string, sql: string, values: unknown[]) {
  await db.query('SAVEPOINT as_owner')
  try {
    await asUser(owner)
    const result = await db.query<Row>(sql, values)
    await db.query('RESET role')
    await db.query('RELEASE SAVEPOINT as_owner')
    return result
  } catch (error) {
    await db.query('ROLLBACK TO SAVEPOINT as_owner')
    await db.query('RESET role')
    throw error
  }
}

function tools(owner: string, self: string) {
  const context = {
    supabaseUrl: '',
    anonKey: '',
    agentId: self,
    threadRootId: null,
    guguHome: '/tmp/gugu-whoami-contract',
    getAccessToken: async () => `x.${Buffer.from(JSON.stringify({ sub: owner })).toString('base64url')}.x`,
  }
  const deps = {
    // PostgREST 的 /rpc 语义:按参数名调用,以主人的 JWT 判权;表返回取行,库里 RAISE 的原文进错误 detail。
    restRpc: async (name: string, body: Record<string, unknown>, profile = 'chat') => {
      if (!/^[a-z_]+$/.test(name) || !/^[a-z_]+$/.test(profile)) throw new Error(`bad rpc name ${profile}.${name}`)
      const keys = Object.keys(body)
      for (const key of keys) if (!/^p_[a-z_]+$/.test(key)) throw new Error(`bad rpc argument ${key}`)
      try {
        const result = await asOwnerQuery(owner,
          `SELECT * FROM ${profile}.${name}(${keys.map((key, index) => `${key} => $${index + 1}`).join(', ')})`,
          keys.map((key) => body[key]))
        return result.rows
      } catch (error) {
        throw new RpcHttpError(400, { detail: String((error as Error).message) })
      }
    },
    // 只允许读 identity.users(自己的资料、主人和好友的名字);agent 的会话与成员 ❌ 直读 —— 那要走按 agent 判的 RPC。
    // 主人自己的状态以主人的 JWT(RLS)直读:置顶、好友、备注,以及主人私聊的两位成员(#84,本就按主人的可见域读)。
    restGet: async (path: string, profile = 'chat') => {
      const ids = (list: string) => list.split(',').map(decodeURIComponent)
      const pinned = /^chat_members\?user_id=eq\.([^&]+)&is_pinned=is\.true&select=chat_id$/.exec(path)
      if (pinned && profile === 'chat') {
        return (await asOwnerQuery(owner, 'SELECT chat_id FROM chat.chat_members WHERE user_id = $1 AND is_pinned', [decodeURIComponent(pinned[1]!)])).rows
      }
      const rosters = /^chat_members\?chat_id=in\.\(([^)]+)\)&select=chat_id,user_id$/.exec(path)
      if (rosters && profile === 'chat') {
        return (await asOwnerQuery(owner, 'SELECT chat_id, user_id FROM chat.chat_members WHERE chat_id = ANY($1)', [ids(rosters[1]!)])).rows
      }
      const friendships = /^friendships\?or=\(user_a_id\.eq\.([^,]+),user_b_id\.eq\.([^)]+)\)&select=user_a_id,user_b_id$/.exec(path)
      if (friendships && profile === 'identity' && decodeURIComponent(friendships[1]!) === owner && decodeURIComponent(friendships[2]!) === owner) {
        return (await asOwnerQuery(owner, 'SELECT user_a_id, user_b_id FROM identity.friendships WHERE user_a_id = $1 OR user_b_id = $1', [owner])).rows
      }
      const aliases = /^contact_overrides\?owner_user_id=eq\.([^&]+)&select=contact_user_id,alias$/.exec(path)
      if (aliases && profile === 'identity' && decodeURIComponent(aliases[1]!) === owner) {
        return (await asOwnerQuery(owner, 'SELECT contact_user_id, alias FROM identity.contact_overrides WHERE owner_user_id = $1', [owner])).rows
      }
      const users = /^users\?id=in\.\(([^)]+)\)&select=([a-z_,]+)$/.exec(path)
      if (users && profile === 'identity') {
        return (await asOwnerQuery(owner, `SELECT ${users[2]} FROM identity.users WHERE id = ANY($1)`, [ids(users[1]!)])).rows
      }
      const match = /^users\?id=eq\.([^&]+)&select=([a-z_,]+)$/.exec(path)
      if (!match || profile !== 'identity') throw new Error(`whoami / conversations must not read tables directly: ${profile}.${path}`)
      return (await asOwnerQuery(owner, `SELECT ${match[2]} FROM identity.users WHERE id = $1`, [decodeURIComponent(match[1]!)])).rows
    },
  }
  return async (name: string, args: Record<string, unknown>) => JSON.parse(String(await callTool(context, name, args, deps)))
}

describe('profile_whoami / message_conversations against the migrated database', () => {
  it('主人、所在的群与每个群里的角色/监听档;主人退了群、agent 还在的群照样在列', async () => {
    const owner = await human('Owner')
    const stranger = await human('Stranger')
    const self = await agentOf(owner, 'Self Agent')
    const strangerAgent = await agentOf(stranger, 'Stranger Agent')

    const ownGroup = await group(owner, 'Own group', [[self, 'member']])
    await db.query("UPDATE chat.chat_members SET listen_mode = 'active' WHERE chat_id = $1 AND user_id = $2", [ownGroup, self])
    const ownerLeft = await group(stranger, 'Owner left', [[owner, 'member']])
    await db.query("INSERT INTO chat.chat_members (chat_id,user_id,role,listen_mode) VALUES ($1,$2,'member','passive')", [ownerLeft, self])
    await db.query('DELETE FROM chat.chat_members WHERE chat_id = $1 AND user_id = $2', [ownerLeft, owner])
    // New owner departures also remove their Agents; recreate the supported legacy Agent-only seat.
    expect((await db.query('SELECT 1 FROM chat.chat_members WHERE chat_id = $1 AND user_id = $2', [ownerLeft, self])).rows).toHaveLength(0)
    await db.query("INSERT INTO chat.chat_members (chat_id,user_id,role,listen_mode) VALUES ($1,$2,'member','passive')", [ownerLeft, self])
    const notMine = await group(stranger, 'Not mine', [[strangerAgent, 'member']])

    // 阴控:主人令牌直读 agent 的成员行,看不到主人已经退了的那个群(这就是要按 agent 判的原因)。
    const direct = await asOwnerQuery<{ chat_id: string }>(owner, 'SELECT chat_id FROM chat.chat_members WHERE user_id = $1', [self])
    expect(direct.rows.map((row) => row.chat_id)).toContain(ownGroup)
    expect(direct.rows.map((row) => row.chat_id)).not.toContain(ownerLeft)

    const call = tools(owner, self)
    const me = await call('profile_whoami', {})
    expect(me).toMatchObject({ display_name: 'Self Agent', owner: { user_id: `user:${owner}`, display_name: 'Owner' } })
    expect(me.owner_user_id).toBeUndefined()
    const groups = new Map((me.groups as Array<{ chat_id: string }>).map((row) => [row.chat_id, row]))
    expect(groups.get(ownGroup)).toMatchObject({ name: 'Own group', status: 'active', role: 'member', listen_mode: 'active' })
    expect(groups.get(ownerLeft)).toMatchObject({ name: 'Owner left', status: 'active', role: 'member', listen_mode: 'passive' })
    expect(groups.has(notMine)).toBe(false)

    // 主人把 ownGroup 置顶了:会话行上的 pinned 读的是主人那一行(agent 自己那一行没人会去点)。
    await db.query('UPDATE chat.chat_members SET is_pinned = true WHERE chat_id = $1 AND user_id = $2', [ownGroup, owner])
    const conversations = ((await call('message_conversations', {})) as { items: Array<{ id: string; kind: string; pinned: boolean }> }).items
    const ids = conversations.map((row) => row.id)
    expect(ids).toEqual(expect.arrayContaining([ownGroup, ownerLeft]))
    expect(ids).not.toContain(notMine)
    expect(Object.keys(conversations[0]!).sort()).toEqual(
      ['id', 'kind', 'last_message_at', 'last_message_preview', 'name', 'pinned', 'public_id', 'status'],
    )
    const pinnedById = new Map(conversations.map((row) => [row.id, row.pinned]))
    expect(pinnedById.get(ownGroup)).toBe(true)
    expect(pinnedById.get(ownerLeft)).toBe(false)
  })

  it('#84 主人与当前好友的私聊在列(主人的备注作名字),按主人读得到;与陌生人的私聊不在列', async () => {
    const owner = await human('Owner')
    const friend = await human('Friend')
    const stranger = await human('Stranger')
    const self = await agentOf(owner, 'Self Agent')
    const [lo, hi] = [owner, friend].sort()
    await db.query('INSERT INTO identity.friendships (user_a_id,user_b_id) VALUES ($1,$2)', [lo, hi])
    await db.query('INSERT INTO identity.contact_overrides (owner_user_id,contact_user_id,alias) VALUES ($1,$2,$3)', [owner, friend, 'Old Wang'])
    const friendDm = await dm(owner, friend)
    const strangerDm = await dm(owner, stranger)
    await db.query(`INSERT INTO chat.messages (id,chat_id,sender_user_id,content,content_type,created_at)
      VALUES ($1,$2,$3,'see you at noon','text',clock_timestamp())`, [randomUUID(), friendDm, friend])

    const call = tools(owner, self)
    const dms = ((await call('message_conversations', { kind: 'dm' })) as { items: Array<Record<string, unknown>> }).items
    expect(dms.map((row) => row.id)).toEqual([friendDm])
    expect(dms[0]).toMatchObject({ owner_dm: true, friend_user_id: `user:${friend}`, friend_display_name: 'Friend', name: 'Old Wang' })
    expect(dms.map((row) => row.id)).not.toContain(strangerDm)

    const history = (await call('message_history', { chat_id: friendDm })) as Array<{ content: string }>
    expect(history.map((row) => row.content)).toContain('see you at noon')
  })
})
