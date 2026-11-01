/** #6562: a person's reaction on an agent's message reaches that agent as a system notice —
 * real RLS insert by the person + real triggers + owner-authorized inbox RPC + the actual reader.
 * The notice rides the existing senderless-system chain (#6016/#6400); the reader renders it as
 * `mode="notice"` with the reaction's name from the shared catalog. Every case rolls back.
 */
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  pullAgentInbox,
  unreadRowFromRpc,
  resetAgentInboxReaderStateForTests,
  type AgentInboxUnreadRow,
} from '@gugu/core/local/agent/agentInboxReader'
import { memoryGroupRulesLedger } from '@gugu/core/local/agent/groupRulesDelivery'
import { REACTIONS } from '@gugu/core/shared/ui/reactionCatalog'

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
    throw new Error('agentReactionNotice6562 requires loopback PostgreSQL')
  }
  db = new Client({ connectionString })
  await db.connect()
})
afterAll(async () => { await db?.end() })
beforeEach(() => { resetAgentInboxReaderStateForTests() })

interface Room { owner: string; alice: string; device: string; group: string; agent: string; peer: string }
async function seed(): Promise<Room> {
  const room: Room = {
    owner: randomUUID(), alice: randomUUID(), device: randomUUID(), group: randomUUID(),
    agent: randomUUID(), peer: randomUUID(),
  }
  for (const [human, name] of [[room.owner, '6562 owner'], [room.alice, 'Alice']] as const) {
    await db.query(`INSERT INTO auth.users (id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
      VALUES ($1,'authenticated','authenticated',$2,'{}','{}',now(),now())`, [human, `${human}@6562.example.invalid`])
    await db.query(`INSERT INTO identity.users (id,type,display_name) VALUES ($1,'human',$2)
      ON CONFLICT (id) DO UPDATE SET display_name=EXCLUDED.display_name`, [human, name])
  }
  await db.query(`INSERT INTO identity.gugu_devices (device_id,user_id,label,hostname,platform)
    VALUES ($1,$2,'6562','6562','darwin')`, [room.device, room.owner])
  for (const agent of [room.agent, room.peer]) {
    await db.query(`INSERT INTO identity.users (id,type,display_name,owner_user_id,device_id,desired_status)
      VALUES ($1,'agent','6562 agent',$2,$3,'online')`, [agent, room.owner, room.device])
  }
  await db.query(`INSERT INTO chat.chats (id,kind,name,creator_user_id) VALUES ($1,'group','6562 group',$2)`, [room.group, room.owner])
  await db.query(`INSERT INTO chat.chat_members (chat_id,user_id,role) VALUES ($1,$2,'owner')`, [room.group, room.owner])
  await db.query(`INSERT INTO chat.chat_members (chat_id,user_id,role,listen_mode,notification_level)
    VALUES ($1,$2,'member','passive','all'),($1,$3,'member','active','all'),($1,$4,'member','active','all')`,
  [room.group, room.agent, room.peer, room.alice])
  return room
}
async function rollback(body: () => Promise<void>): Promise<void> {
  await db.query('BEGIN')
  try {
    await body()
    await db.query('SET CONSTRAINTS ALL IMMEDIATE')
  } finally { await db.query('ROLLBACK') }
}
async function as<T>(userId: string, body: () => Promise<T>): Promise<T> {
  await db.query('SET LOCAL role TO authenticated')
  await db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: userId, role: 'authenticated' })])
  try { return await body() } finally { await db.query('RESET role') }
}
async function agentSays(room: Room, content: string): Promise<string> {
  const id = randomUUID()
  await db.query(`INSERT INTO chat.messages (id,chat_id,sender_user_id,content,content_type)
    VALUES ($1,$2,$3,$4,'text')`, [id, room.group, room.agent, content])
  return id
}
async function pull(room: Room, agent: string): Promise<AgentInboxUnreadRow[]> {
  return as(room.owner, async () => {
    const { rows } = await db.query<{ row: Record<string, unknown> }>(`SELECT to_jsonb(p) AS row FROM identity.pull_agent_inbox_v2($1,$2) p`, [agent, room.group])
    return rows.map(({ row }) => unreadRowFromRpc(row))
  })
}
async function deliver(room: Room, agent: string): Promise<string[]> {
  const texts: string[] = []
  await pullAgentInbox(agent, {
    accessToken: 'owner-authorized-sql-fixture',
    groupRulesLedger: memoryGroupRulesLedger(),
    fetchUnread: () => pull(room, agent),
    inject: async ({ text }) => { texts.push(text); return 'accepted' },
    markRead: async ({ messageId }) => {
      await as(room.owner, () => db.query('SELECT identity.mark_read_on_deliver($1,$2,$3)', [room.group, messageId, agent]))
    },
  })
  return texts
}

describe('#6562 reaction notice reaches the reacted agent through the existing system-message chain', () => {
  it('a person reacts under RLS; only the reacted (passive) agent gets one notice envelope', async () => rollback(async () => {
    const room = await seed()
    const reply = await agentSays(room, '迁移推上去了')
    // Consume the agent's own message noise (nothing): the agent's own line never wakes itself.
    expect(await deliver(room, room.agent)).toEqual([])

    await as(room.alice, () => db.query(
      'INSERT INTO chat.message_reactions (message_id,user_id,emoji) VALUES ($1,$2,$3)', [reply, room.alice, '👍'],
    ))

    const [text, ...rest] = await deliver(room, room.agent)
    expect(rest).toEqual([])
    expect(text).toContain('from="咕咕系统" from_id="system:gugu"')
    expect(text).toContain(' mode="notice"')
    expect(text).toContain('not a request')
    expect(text).toContain('<message_context><![CDATA[👍 = 赞 (Like)]]></message_context>')
    expect(text).toMatch(/Alice\((gugu:\d+|user:[0-9a-f-]+)\) 对你的消息点了 👍/)
    expect(text).toContain(`msg:${reply} 「迁移推上去了」`)
    // Consumed exactly once; the other agent in the room never sees it.
    resetAgentInboxReaderStateForTests()
    expect(await deliver(room, room.agent)).toEqual([])
    expect(await deliver(room, room.peer)).toEqual([])
  }))

  // 目录(客户端)与库里的「只认表情字符」闸是两处:目录里每一个都必须过得了闸,并带着名字到 agent 那儿。
  it('every catalog reaction passes the database emoji gate and arrives named', async () => rollback(async () => {
    const room = await seed()
    const reply = await agentSays(room, '全点一遍')
    for (const { emoji } of REACTIONS) {
      await as(room.alice, () => db.query(
        'INSERT INTO chat.message_reactions (message_id,user_id,emoji) VALUES ($1,$2,$3)', [reply, room.alice, emoji],
      ))
    }
    const texts = await deliver(room, room.agent)
    expect(texts).toHaveLength(REACTIONS.length)
    for (const { emoji, zh, en } of REACTIONS) {
      expect(texts.some((text) => text.includes(`点了 ${emoji}\n`) && text.includes(`${emoji} = ${zh} (${en})`))).toBe(true)
    }
  }))

  it('removing the reaction delivers nothing', async () => rollback(async () => {
    const room = await seed()
    const reply = await agentSays(room, '好')
    await as(room.alice, () => db.query(
      'INSERT INTO chat.message_reactions (message_id,user_id,emoji) VALUES ($1,$2,$3)', [reply, room.alice, '🙏'],
    ))
    expect(await deliver(room, room.agent)).toHaveLength(1)
    await as(room.alice, () => db.query(
      'DELETE FROM chat.message_reactions WHERE message_id=$1 AND user_id=$2 AND emoji=$3', [reply, room.alice, '🙏'],
    ))
    expect(await deliver(room, room.agent)).toEqual([])
  }))
})
