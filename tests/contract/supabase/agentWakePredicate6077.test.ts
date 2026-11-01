/** #6077: 「这条消息唤醒哪个 agent」只有一个写入者 —— chat.message_wakes_agent。
 * 真 INSERT 触发器(push)+ 主人身份的 inbox RPC(pull)+ 真 reader,三者对同一条消息给出同一个收件集。
 * 每个用例都回滚;loopback 护栏防止这套用例碰共享库/生产库。
 */
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  pullAgentInbox,
  resetAgentInboxReaderStateForTests,
} from '@gugu/core/local/agent/agentInboxReader'
import { memoryGroupRulesLedger } from '@gugu/core/local/agent/groupRulesDelivery'

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
    throw new Error('agentWakePredicate6077 requires loopback PostgreSQL')
  }
  db = new Client({ connectionString })
  await db.connect()
})
afterAll(async () => { await db?.end() })
beforeEach(() => { resetAgentInboxReaderStateForTests() })

interface Room { owner: string; peer: string; device: string; group: string; topic: string; a: string; b: string; p: string }
async function seed(): Promise<Room> {
  const room: Room = {
    owner: randomUUID(), peer: randomUUID(), device: randomUUID(), group: randomUUID(), topic: randomUUID(),
    a: randomUUID(), b: randomUUID(), p: randomUUID(),
  }
  for (const human of [room.owner, room.peer]) {
    await db.query(`INSERT INTO auth.users (id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
      VALUES ($1,'authenticated','authenticated',$2,'{}','{}',now(),now())`, [human, `${human}@6077.example.invalid`])
    await db.query(`INSERT INTO identity.users (id,type,display_name) VALUES ($1,'human','6077 human')
      ON CONFLICT (id) DO UPDATE SET display_name=EXCLUDED.display_name`, [human])
  }
  await db.query(`INSERT INTO identity.gugu_devices (device_id,user_id,label,hostname,platform)
    VALUES ($1,$2,'6077','6077','darwin')`, [room.device, room.owner])
  for (const agent of [room.a, room.b, room.p]) {
    await db.query(`INSERT INTO identity.users (id,type,display_name,owner_user_id,device_id,desired_status)
      VALUES ($1,'agent','6077 agent',$2,$3,'online')`, [agent, room.owner, room.device])
  }
  await db.query(`INSERT INTO chat.chats (id,kind,name,creator_user_id)
    VALUES ($1,'group','6077 group',$2)`, [room.group, room.owner])
  const source = randomUUID()
  await db.query(`INSERT INTO chat.messages (id,chat_id,sender_user_id,content,content_type,created_at)
    VALUES ($1,$2,$3,'source','text',now() - interval '1 day')`, [source, room.group, room.owner])
  await db.query(`INSERT INTO chat.chats (id,kind,name,creator_user_id,source_chat_id,source_message_id)
    VALUES ($1,'topic','6077 topic',$2,$3,$4)`, [room.topic, room.owner, room.group, source])
  await db.query(`INSERT INTO chat.chat_members (chat_id,user_id,role)
    VALUES ($1,$3,'owner'),($2,$3,'owner'),($1,$4,'member'),($2,$4,'member')`, [room.group, room.topic, room.owner, room.peer])
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
/** A、B = active,P = passive —— 一条线上两个主动档旁观者正是 #6077 的那一格。 */
async function joinAll(room: Room, chat: string): Promise<void> {
  for (const [agent, mode] of [[room.a, 'active'], [room.b, 'active'], [room.p, 'passive']] as const) {
    await db.query(`INSERT INTO chat.chat_members (chat_id,user_id,role,listen_mode,notification_level)
      VALUES ($1,$2,'member',$3,'all')`, [chat, agent, mode])
  }
}
async function post(chat: string, sender: string, options: {
  to?: string[] | null; replyTo?: string | null; whisper?: boolean; createdAt?: string
} = {}): Promise<string> {
  const id = randomUUID()
  await db.query(`INSERT INTO chat.messages
      (id,chat_id,sender_user_id,content,content_type,to_user_ids,reply_to_message_id,is_whisper,created_at)
    VALUES ($1,$2,$3,'6077 message','text',$4,$5,$6,COALESCE($7::timestamptz, now()))`,
  [id, chat, sender, options.to ?? null, options.replyTo ?? null, options.whisper ?? false, options.createdAt ?? null])
  return id
}
/** push:这条消息给谁排了 nudge。 */
async function pushed(message: string): Promise<string[]> {
  const { rows } = await db.query<{ agent: string }>(`SELECT payload->>'agent_user_id' AS agent
    FROM identity.gugu_device_commands WHERE type='agent.deliver' AND payload->>'message_id'=$1`, [message])
  return rows.map((row) => row.agent).sort()
}
async function unread(room: Room, agent: string): Promise<Array<{ id: string; replyToSenderUserId: string | null }>> {
  await db.query('SET LOCAL role TO authenticated')
  await db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: room.owner, role: 'authenticated' })])
  try {
    const { rows } = await db.query<{ id: string; replyToSenderUserId: string | null }>(
      `SELECT id, reply_to_sender_user_id AS "replyToSenderUserId" FROM identity.pull_agent_inbox_v2($1)`, [agent])
    return rows
  } finally { await db.query('RESET role') }
}
/** pull:这条消息在谁的未读里。 */
async function pulled(room: Room, message: string): Promise<string[]> {
  const holders: string[] = []
  for (const agent of [room.a, room.b, room.p]) {
    if ((await unread(room, agent)).some((row) => row.id === message)) holders.push(agent)
  }
  return holders.sort()
}
const sorted = (...ids: string[]): string[] => [...ids].sort()

// #3641 读者每批按 agent 身份现读群规(chat.chat_facts);契约测试走同一个 SQL 函数,已送达记录放内存。

describe('#6077 chat.message_wakes_agent 真值表(纯谓词,无夹具)', () => {
  // 列序 = 谓词参数序:agent, listen_mode, level, kind, sender, sender_is_agent, sender_is_creator, to, whisper, reply_target
  const cases: Array<[string, unknown[], boolean]> = [
    ['无点名 · 群 · active', ['B', 'active', 'all', 'group', 'H', false, false, null, false, null], true],
    ['无点名 · 话题 · active', ['B', 'active', 'all', 'topic', 'H', false, false, null, false, null], true],
    ['无点名 · passive 不醒', ['B', 'passive', 'all', 'group', 'H', false, false, null, false, null], false],
    ['unaddressed human DM names the peer (gugu-supabase #14)', ['B', 'active', 'all', 'dm', 'H', false, false, null, false, null], true],
    // The backend now treats a person's unaddressed line in a direct chat (dm, ai) as addressed to the other member.
    ['无点名 · 私聊里人说的话点名对端', ['B', 'passive', 'all', 'dm', 'H', false, false, null, false, null], true],
    ['无点名 · ai 会话里人说的话点名对端', ['B', 'passive', 'all', 'ai', 'H', false, false, null, false, null], true],
    ['无点名 · 私聊里 agent 说的话谁也不醒', ['B', 'active', 'all', 'dm', 'A', true, false, null, false, null], false],
    ['无点名 · agent 发的不唤醒人(#1671)', ['B', 'active', 'all', 'group', 'A', true, false, null, false, null], false],
    ['@A · A 是 passive 也醒', ['A', 'passive', 'all', 'group', 'H', false, false, ['A'], false, null], true],
    ['@A · 旁观的 active B 不醒(#6077)', ['B', 'active', 'all', 'group', 'H', false, false, ['A'], false, null], false],
    ['@A · 话题里旁观的 active B 不醒(#6077)', ['B', 'active', 'all', 'topic', 'H', false, false, ['A'], false, null], false],
    ['@all · passive 也醒', ['B', 'passive', 'all', 'group', 'H', false, false, ['*'], false, null], true],
    ['@all 不算显式点到这个人 · level=important', ['B', 'active', 'important', 'group', 'H', false, false, ['*'], false, null], false],
    ['@all · level=important · 群主的消息', ['B', 'active', 'important', 'group', 'H', false, true, ['*'], false, null], true],
    ['@B · level=important · 显式点名穿透', ['B', 'active', 'important', 'group', 'H', false, false, ['B'], false, null], true],
    ['@B · level=none 连点名都关', ['B', 'active', 'none', 'group', 'H', false, false, ['B'], false, null], false],
    ['回复 A 的消息 · A 醒', ['A', 'passive', 'all', 'group', 'H', false, false, null, false, 'A'], true],
    ['回复 A 的消息 · 旁观的 active B 不醒', ['B', 'active', 'all', 'group', 'H', false, false, null, false, 'A'], false],
    ['回复人的消息 · 谁也不醒', ['B', 'active', 'all', 'group', 'H', false, false, null, false, 'H2'], false],
    ['agent @B 交接 · B 醒', ['B', 'passive', 'all', 'group', 'A', true, false, ['B'], false, null], true],
    ['自己发的不唤醒自己', ['A', 'active', 'all', 'group', 'A', true, false, ['A'], false, null], false],
    ['whisper 给 X · X 醒', ['X', 'passive', 'all', 'group', 'H', false, false, ['X'], true, 'A'], true],
    ['whisper 给 X 且回复 A · A 不因回复关系而醒', ['A', 'active', 'all', 'group', 'H', false, false, ['X'], true, 'A'], false],
    ['没有收件人的 whisper 谁也不唤醒', ['B', 'active', 'all', 'group', 'H', false, false, null, true, null], false],
    ['档位未知(NULL)不醒,也不返回 NULL', ['B', null, 'all', 'group', 'H', false, false, null, false, null], false],
  ]
  it.each(cases)('%s', async (_name, args, expected) => {
    const { rows } = await db.query<{ wakes: boolean | null }>(
      `SELECT chat.message_wakes_agent($1,$2,$3,$4,$5,$6,$7,$8::text[],$9,$10) AS wakes`, args)
    expect(rows[0]?.wakes).toBe(expected)
  })
})

describe('#6077 push 与 pull 对同一条消息给出同一个收件集', () => {
  it.each(['group', 'topic'] as const)('%s:无点名 / @一人 / @passive / @all', async (kind) => rollback(async () => {
    const room = await seed()
    const chat = room[kind]
    if (kind === 'topic') await joinAll(room, room.group)
    await joinAll(room, chat)

    const open = await post(chat, room.peer)
    expect(await pushed(open)).toEqual(sorted(room.a, room.b))
    expect(await pulled(room, open)).toEqual(sorted(room.a, room.b))

    // 场景 A 的那一格:@A 时,同为 active 的 B 既不被 nudge,也不会在自己下一次 pull 里拿到它。
    const toA = await post(chat, room.peer, { to: [room.a] })
    expect(await pushed(toA)).toEqual([room.a])
    expect(await pulled(room, toA)).toEqual([room.a])

    const toPassive = await post(chat, room.peer, { to: [room.p] })
    expect(await pushed(toPassive)).toEqual([room.p])
    expect(await pulled(room, toPassive)).toEqual([room.p])

    const toAll = await post(chat, room.peer, { to: ['*'] })
    expect(await pushed(toAll)).toEqual(sorted(room.a, room.b, room.p))
    expect(await pulled(room, toAll)).toEqual(sorted(room.a, room.b, room.p))
  }))

  it.each(['group', 'topic'] as const)('%s:回复 = 点名被回复的那一个', async (kind) => rollback(async () => {
    const room = await seed()
    const chat = room[kind]
    if (kind === 'topic') await joinAll(room, room.group)
    await joinAll(room, chat)
    const fromAgent = await post(chat, room.a, { to: [room.peer] })
    const fromHuman = await post(chat, room.owner)

    const replyToAgent = await post(chat, room.peer, { replyTo: fromAgent })
    expect(await pushed(replyToAgent)).toEqual([room.a])
    expect(await pulled(room, replyToAgent)).toEqual([room.a])

    const replyToHuman = await post(chat, room.peer, { replyTo: fromHuman })
    expect(await pushed(replyToHuman)).toEqual([])
    expect(await pulled(room, replyToHuman)).toEqual([])
  }))

  it('回复的路由目标不随收件人的可读性变:读不到被回复那条的旁观者,不会把「回复」当成无点名广播', async () => rollback(async () => {
    const room = await seed()
    await joinAll(room, room.group)
    const old = await post(room.group, room.owner, { createdAt: new Date(Date.now() - 3_600_000).toISOString() })
    await db.query(`UPDATE chat.chat_members SET hide_history_before = now() - interval '1 minute'
      WHERE chat_id=$1 AND user_id=$2`, [room.group, room.b])

    const reply = await post(room.group, room.peer, { replyTo: old })
    expect(await pushed(reply)).toEqual([])
    expect(await pulled(room, reply)).toEqual([])

    // 阳控:同一个 B 照常收无点名消息,所以上面的空集不是「B 什么都收不到」。
    const open = await post(room.group, room.peer)
    expect(await pulled(room, open)).toEqual(sorted(room.a, room.b))
    // 预览仍按收件人裁剪:被 @ 进来的 B 拿到这条回复,但拿不到它读不到的那条的发送者。
    const replyNamingB = await post(room.group, room.peer, { replyTo: old, to: [room.b] })
    expect((await unread(room, room.b)).find((row) => row.id === replyNamingB)).toEqual({ id: replyNamingB, replyToSenderUserId: null })
    expect((await unread(room, room.a)).some((row) => row.id === replyNamingB)).toBe(false)
  }))

  it('whisper 只唤醒它的收件人:回复关系不把 whisper 的正文带进被回复者主人的设备命令', async () => rollback(async () => {
    const room = await seed()
    await joinAll(room, room.group)
    const fromA = await post(room.group, room.a, { to: [room.peer] })
    const whisper = await post(room.group, room.peer, { to: [room.b], whisper: true, replyTo: fromA })
    expect(await pushed(whisper)).toEqual([room.b])
    expect(await pulled(room, whisper)).toEqual([room.b])
  }))

  // 判据的存在 ≠ 能判假。变异 = 把谓词换成恒真(事务内,随回滚消失):
  //  · push 与 pull **同时**漏给旁观者 ⇒ 两边真的都走这一个谓词(可达性),不是各自另有一份规则在兜;
  //  · 上面那些 toEqual([room.a]) 看得见泄漏 ⇒ 它们的绿不是「这个装置永远读不到 B」。
  it('必失败对照(变异 = 谓词恒真):@A 同时从 push 和 pull 漏给 B 与 passive 的 P', async () => rollback(async () => {
    const room = await seed()
    await joinAll(room, room.group)
    await db.query(`CREATE OR REPLACE FUNCTION chat.message_wakes_agent(
        p_agent_user_id TEXT, p_listen_mode TEXT, p_notification_level TEXT, p_chat_kind TEXT,
        p_sender_user_id TEXT, p_sender_is_agent BOOLEAN, p_sender_is_creator BOOLEAN,
        p_to_user_ids TEXT[], p_is_whisper BOOLEAN, p_reply_target TEXT)
      RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS 'SELECT true'`)
    const toA = await post(room.group, room.peer, { to: [room.a] })
    expect(await pushed(toA)).toEqual(sorted(room.a, room.b, room.p))
    expect(await pulled(room, toA)).toEqual(sorted(room.a, room.b, room.p))
  }))

  // 拉收件箱不比墙钟:`ahead` 的入库时钟比 pull 读到的时钟快(= 两次读之间时钟往回跳了,mac1/colima 实测最多 459 ms),
  // 照样拉得到,同样不含 @别人 的那条。(旧名字 pull_agent_unread / pull_agent_inbox 已由 gugu-supabase 删掉。)
  it('墙钟往回跳也拉得到:入库时钟比读时钟快的消息照样在,同样不含 @别人 的那条', async () => rollback(async () => {
    const room = await seed()
    await joinAll(room, room.group)
    const toA = await post(room.group, room.peer, { to: [room.a] })
    const open = await post(room.group, room.peer)
    const ahead = await post(room.group, room.peer, { createdAt: new Date(Date.now() + 3_600_000).toISOString() })
    await db.query('SET LOCAL role TO authenticated')
    await db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: room.owner, role: 'authenticated' })])
    try {
      const ids = async (rpc: string, agent: string): Promise<string[]> =>
        (await db.query<{ id: string }>(`SELECT id FROM identity.${rpc}($1)`, [agent])).rows.map((row) => row.id)
      // 造出来的态成立:这条消息此刻对墙钟来说确实是「未来的」。
      expect((await db.query<{ ahead: boolean }>(
        'SELECT created_at > statement_timestamp() AS ahead FROM chat.messages WHERE id=$1', [ahead])).rows[0]?.ahead).toBe(true)
      expect(await ids('pull_agent_inbox_v2', room.b)).toEqual([open, ahead])
      expect(await ids('pull_agent_inbox_v2', room.a)).toEqual([toA, open, ahead])
    } finally { await db.query('RESET role') }
  }))

  // #6400 owner 定:叫谁在消息发出那一刻定下,切档只影响之后的消息 —— passive 切到 active 不补投切换前的开放消息。
  it('非系统消息也按发出时刻的档位判:passive 改成 active 后,切换前仍未读的无点名消息不补投,之后的照常投', async () => rollback(async () => {
    const room = await seed()
    await joinAll(room, room.group)
    const before = await post(room.group, room.peer)
    expect(await pulled(room, before)).toEqual(sorted(room.a, room.b))
    await db.query(`UPDATE chat.chat_members SET listen_mode='active' WHERE chat_id=$1 AND user_id=$2`, [room.group, room.p])
    expect(await pulled(room, before)).toEqual(sorted(room.a, room.b))
    // 阳控:切档确实生效了 —— 切换之后发的开放消息叫醒它。
    const after = await post(room.group, room.peer)
    expect(await pulled(room, after)).toEqual(sorted(room.a, room.b, room.p))
  }))
})

// #6327: the database wall clock can step backwards (reproduced inside the Docker VM: now() = .679, the next
// statement's statement_timestamp() = .610). The old reader fenced its scan and its join gate with wall-clock
// comparisons, so an already-pushed message could be "future" to the pull its own nudge triggered. The reader
// fences with chat.messages.ingest_seq. Each control first proves in SQL that the simulated step is real (the
// timestamps really are out of order), then requires the reader to agree with push.
describe('#6327 a wall clock that steps backwards cannot split push from pull', () => {
  async function ids(room: Room, rpc: 'pull_agent_inbox_v2', agent: string): Promise<string[]> {
    await db.query('SET LOCAL role TO authenticated')
    await db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: room.owner, role: 'authenticated' })])
    try {
      return (await db.query<{ id: string }>(`SELECT id FROM identity.${rpc}($1)`, [agent])).rows.map((row) => row.id)
    } finally { await db.query('RESET role') }
  }

  it('scan fence: a message stamped after the pull statement\'s clock is still pulled', async () => rollback(async () => {
    const room = await seed()
    await joinAll(room, room.group)
    // The inserting side's clock ran ahead of the clock the pull will read (= the clock stepped back in between).
    const ahead = await post(room.group, room.peer, {
      to: [room.p], createdAt: new Date(Date.now() + 3_600_000).toISOString(),
    })
    expect(await pushed(ahead)).toEqual([room.p])
    expect((await db.query<{ ahead: boolean }>('SELECT created_at > statement_timestamp() AS ahead FROM chat.messages WHERE id=$1',
      [ahead])).rows[0]?.ahead, 'control: the message is stamped after the pull statement\'s clock').toBe(true)
    expect(await ids(room, 'pull_agent_inbox_v2', room.p)).toContain(ahead)
  }))

  it('join gate: a message that arrived after the join is delivered even when the join was stamped by a later clock', async () => rollback(async () => {
    const room = await seed()
    await joinAll(room, room.group)
    // The join was stamped by a clock that later stepped back: joined_at ends up after the next message's created_at.
    await db.query(`UPDATE chat.chat_members SET joined_at = now() + interval '1 hour'
      WHERE chat_id=$1 AND user_id=$2`, [room.group, room.p])
    const afterJoin = await post(room.group, room.peer, { to: [room.p] })
    expect(await pushed(afterJoin)).toEqual([room.p])
    expect((await db.query<{ stepped: boolean }>(`SELECT cm.joined_at > m.created_at AS stepped
      FROM chat.messages m JOIN chat.chat_members cm ON cm.chat_id = m.chat_id AND cm.user_id = $2 WHERE m.id = $1`,
    [afterJoin, room.p])).rows[0]?.stepped, 'control: the join is stamped after the message').toBe(true)
    expect(await ids(room, 'pull_agent_inbox_v2', room.p)).toContain(afterJoin)
  }))

  it('join gate still holds in sequence terms: a message ingested before the join is not pushed into the new member', async () => rollback(async () => {
    const room = await seed()
    const before = await post(room.group, room.peer, { to: ['*'] })
    await joinAll(room, room.group)
    expect(await ids(room, 'pull_agent_inbox_v2', room.p)).not.toContain(before)
    // positive: the same member does get what arrives after it joined
    const after = await post(room.group, room.peer, { to: ['*'] })
    expect(await ids(room, 'pull_agent_inbox_v2', room.p)).toContain(after)
  }))
})

describe('#6077 场景(话题里两个 active agent,人只 @A)经真 reader', () => {
  async function readOnce(room: Room, agent: string): Promise<string[]> {
    const seen: string[] = []
    await pullAgentInbox(agent, {
      accessToken: 'owner-authorized-sql-fixture',
      groupRulesLedger: memoryGroupRulesLedger(),
      fetchUnread: async () => {
        await db.query('SET LOCAL role TO authenticated')
        await db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: room.owner, role: 'authenticated' })])
        try {
          const { rows } = await db.query(`SELECT
            chat_id AS "chatId", chat_kind AS "chatKind", chat_public_id AS "chatPublicId",
            chat_name AS "chatName", chat_creator_user_id AS "chatCreatorUserId", listen_mode AS "listenMode",
            notification_level AS "notificationLevel", last_read_seq::float8 AS "lastReadSeq",
            id, seq::float8 AS seq, sender_user_id AS "senderUserId", sender_type AS "senderType",
            sender_display_name AS "senderDisplayName", sender_gugu_number AS "senderGuguNumber", content,
            content_type AS "contentType", to_user_ids AS "toUserIds", is_whisper AS "isWhisper",
            reply_to_message_id AS "replyToMessageId", reply_to_sender_user_id AS "replyToSenderUserId",
            reply_to_content AS "replyToContent", thread_root_id AS "threadRootId", is_thread_root AS "isThreadRoot",
            created_at::text AS "createdAt", scan_max_ingest_seq::float8 AS "scanFence"
            FROM identity.pull_agent_inbox_v2($1)`, [agent])
          return rows as never
        } finally { await db.query('RESET role') }
      },
      inject: async ({ messageId }) => { seen.push(messageId!); return 'accepted' },
      markRead: async ({ chatId, messageId }) => {
        await db.query(`SELECT set_config('request.jwt.claims',$1,true)`, [JSON.stringify({ sub: room.owner })])
        await db.query('SELECT identity.mark_read_on_deliver($1,$2,$3)', [chatId, messageId, agent])
      },
    })
    return seen
  }
  async function exactReads(message: string): Promise<string[]> {
    const { rows } = await db.query<{ device_id: string }>(`SELECT device_id FROM chat.message_deliveries
      WHERE message_id=$1 AND status='read' AND device_id LIKE 'gugu-agent:%'`, [message])
    return rows.map((row) => row.device_id.replace('gugu-agent:', '')).sort()
  }

  it('B 的下一次 pull 拿不到那条 @A;A 恰好拿到一次;精确读行只属于 A', async () => rollback(async () => {
    const room = await seed()
    await joinAll(room, room.group)
    await joinAll(room, room.topic)
    const toA = await post(room.topic, room.peer, { to: [room.a] })

    // 这就是真库读数里 +94s~+453s 的那一刻:B 因为别的原因 pull 了一次。
    expect(await readOnce(room, room.b)).toEqual([])
    expect(await readOnce(room, room.a)).toEqual([toA])
    expect(await exactReads(toA)).toEqual([room.a])

    // 阳控:B 的 reader 是通的 —— 随后一条无点名消息它照收,且仍然不捎带那条 @A。
    const open = await post(room.topic, room.peer)
    expect(await readOnce(room, room.b)).toEqual([open])
    expect(await exactReads(toA)).toEqual([room.a])
  }))
})
