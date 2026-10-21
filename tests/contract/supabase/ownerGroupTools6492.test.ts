/** #6492 group_list / group_add_agent(+ #6698 group_update)对着迁移完的真库:MCP 这一侧的真 handler(callTool)+ 库那一侧的真函数
 * (chat.list_owner_groups_as / chat.add_group_agent)。RPC 名、参数名、返回形状、拒绝原文,两边任一改动都在这里红。
 * restRpc 以主人身份(authenticated + JWT sub)在同一条连接上执行,与 PostgREST 调 RPC 同一个判权上下文。
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
    throw new Error('ownerGroupTools6492 requires loopback PostgreSQL')
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
    VALUES ($1,'authenticated','authenticated',$2,'{}','{}',now(),now())`, [id, `${id}@6492.example.invalid`])
  await db.query(`INSERT INTO identity.users (id,type,display_name) VALUES ($1,'human',$2)
    ON CONFLICT (id) DO UPDATE SET display_name=EXCLUDED.display_name`, [id, name])
  await db.query(`INSERT INTO identity.gugu_devices (device_id,user_id,label,hostname,platform)
    VALUES ($1,$2,'6492','6492','darwin')`, [`dev-${id}`, id])
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
async function group(creator: string, name: string, members: Array<[string, string]>, settings: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID()
  await asUser(creator)
  await db.query('SELECT chat.create_gugu_group($1,$2,$3,$4::jsonb)', [
    id, name, creator, JSON.stringify(members.map(([user_id, role]) => ({ user_id, role }))),
  ])
  await db.query('RESET role')
  // 入群灰字(#6386)把「与建群同一个事务写进来的」当初始成员、不发;用例整条在一个事务里,所以把建群时刻往前挪。
  await db.query(`UPDATE chat.chats SET created_at = now() - interval '1 minute' WHERE id = $1`, [id])
  for (const [key, value] of Object.entries(settings)) {
    await db.query(`UPDATE chat.chats SET ${key} = $2 WHERE id = $1`, [id, value])
  }
  return id
}
async function isMember(chatId: string, userId: string): Promise<boolean> {
  return (await db.query('SELECT 1 FROM chat.chat_members WHERE chat_id=$1 AND user_id=$2', [chatId, userId])).rows.length === 1
}

/**
 * PostgREST 的 /rpc 语义:按参数名调用,以调用者(主人)的 JWT 判权;标量返回(jsonb)取值,表返回取行;
 * 库里 RAISE 的原文落进错误 detail(与 restRpc 把响应体 message 拼进 RpcHttpError 同形)。
 */
/**
 * 用例里只有一条 pg 连接,而工具会并发地发读(group_list 同时读群和主人的置顶)。savepoint / SET LOCAL role 在同一条
 * 连接上交错就会互相踩(RELEASE 会连带释放之后建的 savepoint)⇒ 逐个排队执行,真库那边本来就是各自一次 HTTP 请求。
 */
let serial: Promise<unknown> = Promise.resolve()
function oneAtATime<T>(work: () => Promise<T>): Promise<T> {
  const run = serial.then(work, work)
  serial = run.catch(() => undefined)
  return run
}
function ownerRpc(owner: string) {
  return (name: string, body: Record<string, unknown>, profile = 'chat') => oneAtATime(async () => {
    if (!/^[a-z_]+$/.test(name) || !/^[a-z_]+$/.test(profile)) throw new Error(`bad rpc name ${profile}.${name}`)
    const keys = Object.keys(body)
    for (const key of keys) if (!/^p_[a-z_]+$/.test(key)) throw new Error(`bad rpc argument ${key}`)
    await db.query('SAVEPOINT rpc_call')
    try {
      await asUser(owner)
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
  })
}

interface World { owner: string; stranger: string; self: string; sibling: string; strangerAgent: string }
async function world(): Promise<World> {
  const owner = await human('Owner')
  const stranger = await human('Stranger')
  return {
    owner,
    stranger,
    self: await agentOf(owner, 'Self Agent'),
    sibling: await agentOf(owner, 'Sibling Agent'),
    strangerAgent: await agentOf(stranger, 'Stranger Agent'),
  }
}
function tools(w: World) {
  const context = {
    supabaseUrl: '',
    anonKey: '',
    agentId: w.self,
    threadRootId: null,
    guguHome: '/tmp/gugu-6492-contract',
    getAccessToken: async () => `x.${Buffer.from(JSON.stringify({ sub: w.owner })).toString('base64url')}.x`,
  }
  const deps = {
    restRpc: ownerRpc(w.owner),
    // 群能不能看见、在不在里面都只按 RPC 判;直读的只有主人自己那几行里置顶的(置顶是主人自己的状态),以主人的 JWT(RLS)读。
    restGet: (path: string, profile = 'chat') => oneAtATime(async () => {
      const pinned = /^chat_members\?user_id=eq\.([^&]+)&is_pinned=is\.true&select=chat_id$/.exec(path)
      if (!pinned || profile !== 'chat') throw new Error(`group tools must not read tables directly: ${path}`)
      await db.query('SAVEPOINT pinned_read')
      try {
        await asUser(w.owner)
        const result = await db.query('SELECT chat_id FROM chat.chat_members WHERE user_id = $1 AND is_pinned', [decodeURIComponent(pinned[1]!)])
        await db.query('RESET role')
        await db.query('RELEASE SAVEPOINT pinned_read')
        return result.rows
      } catch (error) {
        await db.query('ROLLBACK TO SAVEPOINT pinned_read')
        await db.query('RESET role')
        throw error
      }
    }),
    // group_update 的写口:PostgREST 把这条 PATCH 翻成以主人 JWT 执行的 UPDATE … RETURNING,判权是 chats 的 RLS 与列级 GRANT。
    restPatchReturning: (path: string, body: Record<string, unknown>, profile = 'chat') => oneAtATime(async () => {
      const target = /^chats\?id=eq\.([^&]+)&kind=eq\.group&select=id,name,description$/.exec(path)
      if (!target || profile !== 'chat') throw new Error(`unexpected PATCH ${path}`)
      const columns = Object.keys(body)
      for (const column of columns) if (!['name', 'description'].includes(column)) throw new Error(`unexpected column ${column}`)
      await db.query('SAVEPOINT patch_write')
      try {
        await asUser(w.owner)
        const result = await db.query(
          `UPDATE chat.chats SET ${columns.map((column, index) => `${column} = $${index + 2}`).join(', ')}
            WHERE id = $1 AND kind = 'group' RETURNING id, name, description`,
          [decodeURIComponent(target[1]!), ...columns.map((column) => body[column])],
        )
        await db.query('RESET role')
        await db.query('RELEASE SAVEPOINT patch_write')
        return result.rows
      } catch (error) {
        await db.query('ROLLBACK TO SAVEPOINT patch_write')
        await db.query('RESET role')
        throw error
      }
    }),
  }
  return async (name: string, args: Record<string, unknown>) => JSON.parse(String(await callTool(context, name, args, deps)))
}

describe('#6492 group_list against the migrated database', () => {
  it('列出主人所在的群:joined 按当前 agent 判、需审批按主人角色判,主人不在的群不列', async () => {
    const w = await world()
    const outside = await group(w.owner, 'Agent outside', [[w.stranger, 'member']])
    const inside = await group(w.owner, 'Agent inside', [[w.self, 'member']])
    const approval = await group(w.stranger, 'Needs approval', [[w.owner, 'member']], { agent_join_approval: true })
    const foreign = await group(w.stranger, 'Not the owner’s', [[w.strangerAgent, 'member']])

    // 主人在自己的列表里置顶了 inside(界面的 setChatPinned 写的就是主人那一行的 is_pinned)。
    await db.query('UPDATE chat.chat_members SET is_pinned = true WHERE chat_id = $1 AND user_id = $2', [inside, w.owner])

    const listed = await tools(w)('group_list', {}) as { total: number; items: Array<Record<string, unknown>> }
    const rows = listed.items
    const byId = new Map(rows.map((row) => [row.chat_id, row]))
    expect(byId.get(outside)).toMatchObject({ name: 'Agent outside', member_count: 2, joined: false, agent_join_needs_approval: false, pinned: false })
    expect(byId.get(inside)).toMatchObject({ joined: true, pinned: true })
    expect(byId.get(approval)).toMatchObject({ joined: false, agent_join_needs_approval: true })
    expect(byId.has(foreign)).toBe(false)
    expect(listed.total).toBe(rows.length)
    expect(Object.keys(byId.get(outside)!).sort()).toEqual(
      ['agent_join_needs_approval', 'chat_id', 'joined', 'member_count', 'name', 'pinned', 'public_id'],
    )
    const pinnedOnly = await tools(w)('group_list', { pinned: true }) as { items: Array<Record<string, unknown>> }
    expect(pinnedOnly.items.map((row) => row.chat_id)).toEqual([inside])
  })
})

describe('#6492 group_add_agent against the migrated database', () => {
  it('自己入群 ⇒ joined,成员行落库,群里落一行入群灰字;再调一次 ⇒ already_member', async () => {
    const w = await world()
    const target = await group(w.owner, 'Join me', [[w.stranger, 'member']])
    const call = tools(w)
    expect(await call('group_add_agent', { chat_id: target }))
      .toEqual({ status: 'joined', chat_id: target, agent_user_id: `user:${w.self}` })
    expect(await isMember(target, w.self)).toBe(true)
    const notices = await db.query(
      `SELECT client_message_id FROM chat.messages WHERE chat_id = $1 AND content_type = 'system' AND client_message_id LIKE 'member-joined:%'`,
      [target],
    )
    expect(notices.rows.map((row) => String(row.client_message_id)).some((id) => id.includes(w.self))).toBe(true)
    expect(await call('group_add_agent', { chat_id: target }))
      .toEqual({ status: 'already_member', chat_id: target, agent_user_id: `user:${w.self}` })
  })

  it('需审批且主人不是管理员 ⇒ pending_approval,不入群,待审请求记着主人替它发起', async () => {
    const w = await world()
    const target = await group(w.stranger, 'Approval', [[w.owner, 'member']], { agent_join_approval: true })
    const result = await tools(w)('group_add_agent', { chat_id: target })
    expect(result).toMatchObject({ status: 'pending_approval', chat_id: target, agent_user_id: `user:${w.self}` })
    expect(typeof result.request_id).toBe('string')
    expect(await isMember(target, w.self)).toBe(false)
    const request = await db.query(
      `SELECT requester_user_id, requested_by_user_id, status FROM chat.group_join_requests WHERE id = $1`, [result.request_id],
    )
    expect(request.rows).toEqual([{ requester_user_id: w.self, requested_by_user_id: w.owner, status: 'pending' }])
  })

  it('把主人名下的另一个 agent 拉进来(user: 地址)', async () => {
    const w = await world()
    const target = await group(w.owner, 'Bring a sibling', [[w.self, 'member']])
    expect(await tools(w)('group_add_agent', { chat_id: target, agent: `user:${w.sibling}` }))
      .toEqual({ status: 'joined', chat_id: target, agent_user_id: `user:${w.sibling}` })
    expect(await isMember(target, w.sibling)).toBe(true)
  })

  it('别人的 agent 与人都被拒并指向 message_invite;正对照:主人自己的 agent 同一个群能进', async () => {
    const w = await world()
    const target = await group(w.owner, 'Owners only', [[w.stranger, 'member']])
    const call = tools(w)
    await expect(call('group_add_agent', { chat_id: target, agent: `user:${w.strangerAgent}` })).rejects.toThrow(/message_invite/)
    await expect(call('group_add_agent', { chat_id: target, agent: `user:${w.stranger}` })).rejects.toThrow(/message_invite/)
    expect(await isMember(target, w.strangerAgent)).toBe(false)
    expect(await call('group_add_agent', { chat_id: target, agent: `user:${w.sibling}` })).toMatchObject({ status: 'joined' })
  })

  it('主人不在的群 ⇒ 报错指向 group_list,不入群', async () => {
    const w = await world()
    const foreign = await group(w.stranger, 'Foreign', [[w.strangerAgent, 'member']])
    await expect(tools(w)('group_add_agent', { chat_id: foreign })).rejects.toThrow(/group_list/)
    expect(await isMember(foreign, w.self)).toBe(false)
  })
})

describe('#6698 group_update against the migrated database', () => {
  async function nameOf(chatId: string): Promise<string> {
    return String((await db.query('SELECT name FROM chat.chats WHERE id = $1', [chatId])).rows[0]?.name)
  }

  it('主人是群主或管理员 ⇒ 改名、改群介绍落库;agent 自己只是普通成员也一样', async () => {
    const w = await world()
    const owned = await group(w.owner, 'Claude 84、设计同事', [[w.self, 'member']])
    const call = tools(w)
    expect(await call('group_update', { chat_id: owned, name: '问题汇总群', description: '收问题' }))
      .toEqual({ chat_id: owned, name: '问题汇总群', description: '收问题' })
    expect(await nameOf(owned)).toBe('问题汇总群')
    const administered = await group(w.stranger, 'Admin here', [[w.owner, 'admin']])
    expect(await call('group_update', { chat_id: administered, name: 'Renamed by admin' })).toMatchObject({ name: 'Renamed by admin' })
  })

  it('主人只是普通成员、或不在群里 ⇒ 报错说主人没权限,群名不变', async () => {
    const w = await world()
    const member = await group(w.stranger, 'Member only', [[w.owner, 'member']])
    const foreign = await group(w.stranger, 'Foreign', [[w.strangerAgent, 'member']])
    const call = tools(w)
    await expect(call('group_update', { chat_id: member, name: 'Hijacked' })).rejects.toThrow(/your owner is not the owner or an admin/)
    await expect(call('group_update', { chat_id: foreign, name: 'Hijacked' })).rejects.toThrow(/your owner is not the owner or an admin/)
    expect(await nameOf(member)).toBe('Member only')
    expect(await nameOf(foreign)).toBe('Foreign')
  })
})
