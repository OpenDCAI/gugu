/** #6016: real INSERT triggers + owner-authorized inbox RPC + the actual reader.
 * #6860 (gugu-supabase, same-name branch): a message with no sender and no addressee — the server's own
 * narration, e.g. "X joined", "agent 较多" — is not a request, so it wakes no agent. Wakes are decided once, at write
 * time (#6400); #6016's per-event listening-state table is gone. Named system events keep their delivery and
 * notification-level gates. Each cell keeps a positive control.
 * Every normal case rolls back; the concurrent-join case owns and deletes its fixture.
 * The loopback guard prevents this suite from mutating shared/prod databases.
 */
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  pullAgentInbox,
  resetAgentInboxReaderStateForTests,
  type AgentInboxUnreadRow,
} from '@gugu/core/local/agent/agentInboxReader'
import { memoryGroupRulesLedger, type ChatFactsRow } from '@gugu/core/local/agent/groupRulesDelivery'

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
    throw new Error('systemMessageDelivery6016 requires loopback PostgreSQL')
  }
  db = new Client({ connectionString })
  await db.connect()
})
afterAll(async () => { await db?.end() })
beforeEach(() => { resetAgentInboxReaderStateForTests() })

interface Room { owner: string; peers: string[]; device: string; group: string; topic: string; agents: string[] }
async function seed(): Promise<Room> {
  const room: Room = {
    owner: randomUUID(), peers: [randomUUID(), randomUUID()], device: randomUUID(), group: randomUUID(), topic: randomUUID(),
    agents: Array.from({ length: 8 }, () => randomUUID()),
  }
  // Real auth owners satisfy the deferred device FK; complete human membership
  // keeps even the source group valid when only its topic receives test agents.
  for (const human of [room.owner, ...room.peers]) {
    await db.query(`INSERT INTO auth.users (id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
      VALUES ($1,'authenticated','authenticated',$2,'{}','{}',now(),now())`, [human, `${human}@6016.example.invalid`])
    await db.query(`INSERT INTO identity.users (id,type,display_name) VALUES ($1,'human','6016 human')
      ON CONFLICT (id) DO UPDATE SET display_name=EXCLUDED.display_name`, [human])
  }
  await db.query(`INSERT INTO identity.gugu_devices (device_id,user_id,label,hostname,platform)
    VALUES ($1,$2,'6016','6016','darwin')`, [room.device, room.owner])
  for (const agent of room.agents) {
    await db.query(`INSERT INTO identity.users (id,type,display_name,owner_user_id,device_id,desired_status)
      VALUES ($1,'agent','6016 agent',$2,$3,'online')`, [agent, room.owner, room.device])
  }
  await db.query(`INSERT INTO chat.chats (id,kind,name,creator_user_id)
    VALUES ($1,'group','6016 group',$2)`, [room.group, room.owner])
  const source = randomUUID()
  await db.query(`INSERT INTO chat.messages (id,chat_id,sender_user_id,content,content_type,created_at)
    VALUES ($1,$2,$3,'source','text',now() - interval '1 day')`, [source, room.group, room.owner])
  await db.query(`INSERT INTO chat.chats (id,kind,name,creator_user_id,source_chat_id,source_message_id)
    VALUES ($1,'topic','6016 topic',$2,$3,$4)`, [room.topic, room.owner, room.group, source])
  await db.query(`INSERT INTO chat.chat_members (chat_id,user_id,role)
    VALUES ($1,$3,'owner'),($2,$3,'owner')`, [room.group, room.topic, room.owner])
  for (const peer of room.peers) {
    await db.query(`INSERT INTO chat.chat_members (chat_id,user_id,role) VALUES ($1,$2,'member')`, [room.group, peer])
  }
  return room
}
async function rollback(body: () => Promise<void>): Promise<void> {
  await db.query('BEGIN')
  try {
    await body()
    // A rollback alone never checks deferrable FKs/membership constraints.
    await db.query('SET CONSTRAINTS ALL IMMEDIATE')
  } finally { await db.query('ROLLBACK') }
}
async function join(chat: string, agent: string, mode = 'active', client = db): Promise<void> {
  await client.query(`INSERT INTO chat.chat_members (chat_id,user_id,role,listen_mode,notification_level)
    VALUES ($1,$2,'member',$3,'all') ON CONFLICT (chat_id,user_id) DO NOTHING`, [chat, agent, mode])
}
async function system(chat: string, to: string[] | null = null, sender: string | null = null): Promise<string> {
  const id = randomUUID()
  await db.query(`INSERT INTO chat.messages (id,chat_id,sender_user_id,content,content_type,to_user_ids)
    VALUES ($1,$2,$3,'system event','system',$4)`, [id, chat, sender, to])
  return id
}
async function say(chat: string, sender: string): Promise<string> {
  const id = randomUUID()
  await db.query(`INSERT INTO chat.messages (id,chat_id,sender_user_id,content,content_type)
    VALUES ($1,$2,$3,'hello','text')`, [id, chat, sender])
  return id
}
async function recipients(message: string): Promise<string[]> {
  const { rows } = await db.query<{ agent: string }>(`SELECT payload->>'agent_user_id' AS agent
    FROM identity.gugu_device_commands WHERE type='agent.deliver' AND payload->>'message_id'=$1`, [message])
  return rows.map((row) => row.agent).sort()
}
async function notices(chat: string): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(`SELECT id FROM chat.messages
    WHERE chat_id=$1 AND client_message_id LIKE 'agent-flood:%'`, [chat])
  return rows.map((row) => row.id)
}
async function pull(room: Room, agent: string, chat = room.group): Promise<AgentInboxUnreadRow[]> {
  await db.query('SET LOCAL role TO authenticated')
  await db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: room.owner, role: 'authenticated' })])
  try {
    const { rows } = await db.query<AgentInboxUnreadRow>(`SELECT
      chat_id AS "chatId", chat_kind AS "chatKind", chat_public_id AS "chatPublicId",
      chat_name AS "chatName", chat_creator_user_id AS "chatCreatorUserId", listen_mode AS "listenMode",
      notification_level AS "notificationLevel", last_read_seq::float8 AS "lastReadSeq",
      id, seq::float8 AS seq, sender_user_id AS "senderUserId", sender_type AS "senderType",
      sender_display_name AS "senderDisplayName", sender_gugu_number AS "senderGuguNumber", content,
      content_type AS "contentType", to_user_ids AS "toUserIds", is_whisper AS "isWhisper",
      reply_to_message_id AS "replyToMessageId", reply_to_sender_user_id AS "replyToSenderUserId",
      reply_to_content AS "replyToContent", thread_root_id AS "threadRootId", is_thread_root AS "isThreadRoot",
      created_at::text AS "createdAt", scan_max_ingest_seq::float8 AS "scanFence"
      FROM identity.pull_agent_inbox_v2($1,$2)`, [agent, chat])
    return rows
  } finally { await db.query('RESET role') }
}
async function readOnce(room: Room, agent: string, chat = room.group): Promise<string[]> {
  const seen: string[] = []
  await pullAgentInbox(agent, {
    accessToken: 'owner-authorized-sql-fixture',
    fetchChatFacts: (chatId, asUserId) => chatFactsAs(room.owner, chatId, asUserId),
    groupRulesLedger: memoryGroupRulesLedger(),
    fetchUnread: () => pull(room, agent, chat),
    inject: async ({ messageId, text }) => {
      expect(text).toContain('from_id="system:gugu"')
      seen.push(messageId!)
      return 'accepted'
    },
    markRead: async ({ messageId }) => {
      await db.query(`SELECT set_config('request.jwt.claims',$1,true)`, [JSON.stringify({ sub: room.owner })])
      await db.query('SELECT identity.mark_read_on_deliver($1,$2,$3)', [chat, messageId, agent])
    },
  })
  return seen
}

// #3641 读者每批按 agent 身份现读群规(chat.chat_facts);契约测试走同一个 SQL 函数,已送达记录放内存。
async function chatFactsAs(owner: string, chatId: string, asUserId: string): Promise<ChatFactsRow | null> {
  await db.query('SET LOCAL role TO authenticated')
  await db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: owner, role: 'authenticated' })])
  try {
    const { rows } = await db.query<ChatFactsRow>('SELECT kind, source_chat_id, group_prompt FROM chat.chat_facts($1,$2)', [chatId, asUserId])
    return rows[0] ?? null
  } finally { await db.query('RESET role') }
}

describe('#6016 system delivery follows event-time listening state; #6860 unaddressed server events wake no agent', () => {
  it.each(['group', 'topic'] as const)('an unaddressed system event wakes no agent in %s; a named one reaches its target in any mode', async (kind) => rollback(async () => {
    const room = await seed()
    const chat = room[kind]
    await join(chat, room.agents[0]!)
    await join(chat, room.agents[1]!, 'passive')
    // #6860: nobody is named on it, so it is not a request — not even for the active agent.
    const open = await system(chat)
    expect(await recipients(open)).toEqual([])
    expect(await readOnce(room, room.agents[0]!, chat)).toEqual([])
    expect(await readOnce(room, room.agents[1]!, chat)).toEqual([])
    // Positive control: a named system event reaches its target, passive included.
    const targeted = await system(chat, [room.agents[1]!])
    expect(await recipients(targeted)).toEqual([room.agents[1]])
    // Retrying the same durable event must not run the AFTER INSERT fanout again.
    await db.query(`INSERT INTO chat.messages (id,chat_id,content,content_type,to_user_ids)
      VALUES ($1,$2,'system event','system',$3) ON CONFLICT (id) DO NOTHING`, [targeted, chat, [room.agents[1]!]])
    expect(await recipients(targeted)).toEqual([room.agents[1]])
    expect(await readOnce(room, room.agents[1]!, chat)).toEqual([targeted])
    expect(await readOnce(room, room.agents[0]!, chat)).toEqual([])
    const toActive = await system(chat, [room.agents[0]!])
    expect(await recipients(toActive)).toEqual([room.agents[0]])
    expect(await readOnce(room, room.agents[0]!, chat)).toEqual([toActive])
  }))

  it('switches agents to passive without the notice waking any of them; the next named delivery carries the new mode', async () => rollback(async () => {
    const room = await seed()
    await db.query('UPDATE chat.chats SET agent_flood_threshold=2 WHERE id=$1', [room.group])
    await join(room.group, room.agents[0]!)
    await join(room.group, room.agents[1]!, 'passive')
    await join(room.group, room.agents[2]!, 'passive')
    const [notice] = await notices(room.group)
    expect(notice).toBeTruthy()
    // #6860: the notice says there are too many agents — it wakes none of them (#6016 woke the one still active).
    expect(await recipients(notice!)).toEqual([])
    const { rows } = await db.query<{ listen_mode: string }>('SELECT listen_mode FROM chat.chat_members WHERE chat_id=$1 AND user_id=$2', [room.group, room.agents[0]])
    expect(rows[0]?.listen_mode).toBe('passive')
    expect((await pull(room, room.agents[0]!)).some((row) => row.id === notice)).toBe(false)
    expect(await readOnce(room, room.agents[0]!)).toEqual([])
    expect(await readOnce(room, room.agents[1]!)).toEqual([])
    expect(await readOnce(room, room.agents[2]!)).toEqual([])
    // Positive control: the agent learns the transition from its next delivery, whose envelope carries 'passive'.
    const named = await system(room.group, [room.agents[0]!])
    expect(await recipients(named)).toEqual([room.agents[0]])
    expect((await pull(room, room.agents[0]!)).find((row) => row.id === named)?.listenMode).toBe('passive')
    expect(await readOnce(room, room.agents[0]!)).toEqual([named])
    resetAgentInboxReaderStateForTests()
    expect(await readOnce(room, room.agents[0]!)).toEqual([])
    // Unaddressed notifications after the transition are no wakeups either.
    const later = await system(room.group)
    expect(await recipients(later)).toEqual([])
    expect(await readOnce(room, room.agents[0]!)).toEqual([])
    // Retry and a newcomer neither create a second notice nor retroactively add a recipient.
    await db.query('SELECT chat.apply_agent_flood_rule($1)', [room.group])
    await join(room.group, room.agents[3]!, 'passive')
    await join(room.group, room.agents[3]!, 'passive')
    expect(await notices(room.group)).toEqual([notice])
    expect(await recipients(notice!)).toEqual([])
    expect(await pull(room, room.agents[3]!)).toEqual([])
  }))

  it('does not revive passive-time events when later set active, or replay the notice for late enforced joiners', async () => rollback(async () => {
    const room = await seed()
    await db.query('UPDATE chat.chats SET agent_flood_threshold=1 WHERE id=$1', [room.group])
    await join(room.group, room.agents[0]!)
    await join(room.group, room.agents[1]!)
    const [notice] = await notices(room.group)
    await join(room.group, room.agents[2]!)
    expect(await notices(room.group)).toEqual([notice])
    expect(await recipients(notice!)).toEqual([])
    expect(await pull(room, room.agents[2]!)).toEqual([])
    const passiveEvent = await system(room.group)
    await db.query("UPDATE chat.chat_members SET listen_mode='active' WHERE chat_id=$1 AND user_id=$2", [room.group, room.agents[2]])
    expect(await readOnce(room, room.agents[2]!)).toEqual([])
    expect(await recipients(passiveEvent)).toEqual([])
    // #6860: an unaddressed server event stays silent even for the now-active agent.
    const activeEvent = await system(room.group)
    expect(await recipients(activeEvent)).toEqual([])
    expect(await readOnce(room, room.agents[2]!)).toEqual([])
    // Positive control: once active, it is woken by ordinary room traffic — a person speaking to nobody in particular.
    const talk = await say(room.group, room.owner)
    expect(await recipients(talk)).toEqual([room.agents[2]])
  }))

  it('keeps notification-level and agent-sender gates for system events', async () => rollback(async () => {
    const room = await seed()
    for (const agent of room.agents.slice(0, 3)) await join(room.group, agent)
    await db.query("UPDATE chat.chat_members SET notification_level='none' WHERE chat_id=$1 AND user_id=$2", [room.group, room.agents[1]])
    await db.query("UPDATE chat.chat_members SET notification_level='important' WHERE chat_id=$1 AND user_id=$2", [room.group, room.agents[2]])
    // #6860: unaddressed, it wakes nobody whatever the level (the 'all' agent included).
    const open = await system(room.group)
    expect(await recipients(open)).toEqual([])
    expect(await recipients(await system(room.group, null, room.agents[0]!))).toEqual([])
    // Named: 'important' accepts a naming, 'none' does not; positive control: 'all' accepts it.
    const addressed = await system(room.group, room.agents.slice(1, 3))
    expect(await recipients(addressed)).toEqual([room.agents[2]])
    const toAll = await system(room.group, [room.agents[0]!])
    expect(await recipients(toAll)).toEqual([room.agents[0]])
    expect(await readOnce(room, room.agents[1]!)).toEqual([])
    expect(await readOnce(room, room.agents[2]!)).toEqual([addressed])
    expect(await readOnce(room, room.agents[0]!)).toEqual([toAll])
  }))

  it('does not turn a deleted agent author into a system sender', async () => rollback(async () => {
    const room = await seed()
    await join(room.group, room.agents[0]!)
    await join(room.group, room.agents[1]!)
    const original = await system(room.group, null, room.agents[1]!)
    expect(await recipients(original)).toEqual([])
    await db.query('DELETE FROM identity.users WHERE id=$1', [room.agents[1]])
    expect((await pull(room, room.agents[0]!)).some((row) => row.id === original)).toBe(false)
    // Positive control: a real system event still reaches it — a named one, since unaddressed ones wake no agent (#6860).
    const actualSystem = await system(room.group, [room.agents[0]!])
    expect(await readOnce(room, room.agents[0]!)).toEqual([actualSystem])
  }))

  it('serializes concurrent joins into one notice that wakes none of the transitioning agents', async () => {
    const clients: DatabaseClient[] = []
    let room: Room | undefined
    try {
      await db.query('BEGIN')
      room = await seed()
      for (const agent of room.agents.slice(0, 2)) await join(room.group, agent)
      await db.query('COMMIT')
      for (let i = 0; i < 4; i += 1) {
        const client = new Client({ connectionString })
        clients.push(client)
        await client.connect()
        await client.query("SET statement_timeout='8s'")
      }
      const fixture = room
      const results = await Promise.allSettled(clients.map((client, i) => join(fixture.group, fixture.agents[i + 2]!, 'active', client)))
      expect(results.map((result) => result.status)).toEqual(Array(4).fill('fulfilled'))
      const ids = await notices(room.group)
      expect(ids).toHaveLength(1)
      // #6860: the one notice wakes none of them. Positive control: the transition itself did happen to all six.
      expect(await recipients(ids[0]!)).toEqual([])
      const passive = async () => (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM chat.chat_members
        WHERE chat_id=$1 AND user_id=ANY($2::text[]) AND listen_mode='passive'`, [fixture.group, fixture.agents.slice(0, 6)])).rows[0]!.n
      expect(await passive()).toBe(6)
      await db.query('SELECT chat.apply_agent_flood_rule($1)', [room.group])
      expect(await notices(room.group)).toEqual(ids)
      expect(await recipients(ids[0]!)).toEqual([])
      expect(await passive()).toBe(6)
    } finally {
      await Promise.all(clients.map((client) => client.end()))
      await db.query('ROLLBACK')
      if (room) {
        await db.query('DELETE FROM chat.chats WHERE id=ANY($1)', [[room.topic, room.group]])
        // erase_human_account deletes commands, owned agents and devices in FK order.
        // Manual identity/device deletion before it violates lifecycle preconditions.
        await db.query('DELETE FROM auth.users WHERE id=ANY($1::uuid[])', [[room.owner, ...room.peers]])
      }
    }
  })
})
