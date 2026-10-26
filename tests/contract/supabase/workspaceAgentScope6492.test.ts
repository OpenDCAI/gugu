// @vitest-environment node
/** #6492 第 3 刀:agent 碰群文件夹,对着迁移完的真库 —— 客户端这一侧的真代码 + 库那一侧的 chat.workspace_*_as。
 * RPC 名、参数名、返回形状、拒绝原文,两边任一改动都在这里红。
 * 客户端是 App 的 `gugu.files` 替 agent 干活的那条路(app-files-core 带 asAgent,群文件夹工具搬进 App 的 A2 / G5 / G1):
 * 群文件夹 App 的工具(workspace__*)经它读写;咕咕 MCP 自己不再有 workspace 工具。
 * 工作区 App L4(gugu-supabase 20260929064500):*_as 只回元数据(list 在库里分页筛选),按 uuid 查行。
 * 文本文件的内容读改走文件服务,不在这个 job 里(本 job 只起了 db)。
 * rpc 以主人身份(authenticated + JWT sub)按参数名调函数,与 PostgREST 调 RPC 同一个判权上下文;
 * 存成文件的字节(#7290 gugu-3)经 attachments 函数:这里换成它在库里做的那两步 —— 把上传登记成 blob(service_role 的
 * file_blob_register),再以调用者身份调 file_place_as / file_replace_as(sb#143);OSS 不在这个栈上。桶的删除桩只记账。
 * 每条用例 BEGIN…ROLLBACK;loopback 护栏防止它碰共享库/生产库。
 */
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

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
    throw new Error('workspaceAgentScope6492 requires loopback PostgreSQL')
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
    VALUES ($1,'authenticated','authenticated',$2,'{}','{}',now(),now())`, [id, `${id}@6492ws.example.invalid`])
  await db.query(`INSERT INTO identity.users (id,type,display_name) VALUES ($1,'human',$2)
    ON CONFLICT (id) DO UPDATE SET display_name=EXCLUDED.display_name`, [id, name])
  await db.query(`INSERT INTO identity.gugu_devices (device_id,user_id,label,hostname,platform)
    VALUES ($1,$2,'6492','6492','darwin')`, [`dev-${id}`, id])
  return id
}
async function asUser(id: string): Promise<void> {
  await db.query('SET LOCAL role TO authenticated')
  await db.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: id, role: 'authenticated' })])
}

interface World { owner: string; peer: string; agent: string; group: string }
async function world(peerOwnsGroup = false): Promise<World> {
  const owner = await human('Owner')
  const peer = await human('Peer')
  const agent = randomUUID()
  await db.query(`INSERT INTO identity.users (id,type,display_name,owner_user_id,device_id)
    VALUES ($1,'agent','Workspace Agent',$2,$3)`, [agent, owner, `dev-${owner}`])
  const group = randomUUID()
  const groupOwner = peerOwnsGroup ? peer : owner
  await asUser(groupOwner)
  await db.query('SELECT chat.create_gugu_group($1,$2,$3,$4::jsonb)', [group, 'Workspace group', groupOwner, '[]'])
  await db.query('RESET role')
  await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES ($1,$2,'member')", [group, peerOwnsGroup ? owner : peer])
  await db.query('RESET role')
  return { owner, peer, agent, group }
}

/** The signed-in person this case runs as: their token is what every *_as door judges (the person owns the agent). */
let current: World | null = null
const removed: string[] = []

/**
 * The client the App runtime uses, answered by this database: an RPC by parameter name as the person (PostgREST's
 * context); a table read is refused — what acts for an agent goes through its door only; the bucket is a stub.
 */
const client = {
  rpc: (name: string, body: Record<string, unknown>) => {
    const run = async (columns = '*') => {
      if (columns !== '*' && !/^[a-z_]+(?:,[a-z_]+)*$/.test(columns)) throw new Error(`bad rpc projection ${columns}`)
      if (!/^[a-z_]+$/.test(name)) throw new Error(`bad rpc name ${name}`)
      const keys = Object.keys(body)
      for (const key of keys) if (!/^p_[a-z_]+$/.test(key)) throw new Error(`bad rpc argument ${key}`)
      await db.query('SAVEPOINT rpc_call')
      try {
        await asUser(current!.owner)
        const result = await db.query(
          `SELECT ${columns} FROM chat.${name}(${keys.map((key, index) => `${key} => $${index + 1}`).join(', ')})`,
          keys.map((key) => body[key]),
        )
        await db.query('RESET role')
        await db.query('RELEASE SAVEPOINT rpc_call')
        // A SETOF of a plain type (workspace_deletable_as) comes back as its values, as PostgREST answers it.
        const plain = result.fields.length === 1 && result.fields[0]!.name === name
        return { data: plain ? result.rows.map((row) => (row as Record<string, unknown>)[name]) : result.rows, error: null }
      } catch (error) {
        await db.query('ROLLBACK TO SAVEPOINT rpc_call')
        await db.query('RESET role')
        // As PostgREST hands a refusal on: the sentence, and the code a door puts in hint.
        const { hint, detail } = error as { hint?: string; detail?: string }
        return { data: null, error: { message: String((error as Error).message), hint: hint ?? '', details: detail ?? '' } }
      }
    }
    // PostgREST runs only when awaited; select changes the real SQL projection before that execution.
    return {
      select: (columns: string) => run(columns),
      then: (...args: Parameters<ReturnType<typeof run>['then']>) => run().then(...args),
    }
  },
  from: (table: string) => {
    throw new Error(`acting for an agent reads no table directly: ${table}`)
  },
  storage: {
    from: (bucket: string) => ({
      // Supabase 不许直删 storage.objects(「Use the Storage API instead」),桩只记下删了哪个对象。
      remove: async (paths: string[]) => {
        removed.push(...paths.map((path) => `${bucket}/${path}`))
        return { error: null }
      },
    }),
  },
}
vi.mock('@gugu/core/cloud/supabase', () => ({ createGuguSupabaseClient: () => client }))
vi.mock('@main/core/extensions/account-token', () => ({ currentAccountAccessToken: async () => `h.${Buffer.from(JSON.stringify({ sub: current!.owner })).toString('base64url')}.s` }))
vi.mock('@main/core/extensions/file-sync', () => ({ fileSync: {} }))
vi.mock('@main/lib/logger', () => ({ log: { warn: () => undefined } }))
const { handedChatsAs } = await import('../../../apps/desktop/electron/session/main/core/extensions/extension-program-surface')

/** Staged uploads (the bytes the attachments function would read back from OSS), by staging key. */
const staged = new Map<string, Uint8Array>()
/**
 * The attachments function's place, as it is in the database: the staged bytes registered as a blob (service_role, as the
 * function does after reading them), then the *_as door as the signed-in person — its refusal mapped as the function maps it.
 */
vi.mock('@gugu/core/cloud/attachmentsApi', async (importOriginal) => {
  const real = await importOriginal<typeof import('@gugu/core/cloud/attachmentsApi')>()
  return {
    ...real,
    configuredEndpoint: (token: string) => ({ supabaseUrl: 'http://attachments.invalid', anonKey: 'anon', token }),
    uploadAttachmentBytes: async (_endpoint: unknown, file: { bytes: Uint8Array }) => {
      const key = `staging/${current!.owner}/${randomUUID()}`
      staged.set(key, new Uint8Array(file.bytes))
      return key
    },
    placeAttachment: async (_endpoint: unknown, args: Record<string, unknown>) => {
      const key = String(args.staging_key)
      const bytes = staged.get(key)!
      await db.query('SET LOCAL role service_role')
      await db.query('SELECT chat.file_blob_register($1,$2,$3,$4,$5,null,null)',
        [current!.owner, key, createHash('sha256').update(bytes).digest('hex'), bytes.byteLength, args.content_type ?? 'application/octet-stream'])
      await db.query('RESET role')
      const as = args.as_user_id ?? current!.owner
      const { data, error } = args.item_id
        ? await client.rpc('file_replace_as', { p_staging_key: key, p_item_id: args.item_id, p_as_user_id: as, p_expected_version: args.expected_version })
        : await client.rpc('file_place_as', { p_staging_key: key, p_chat_id: args.chat_id, p_as_user_id: as, p_file_name: args.file_name, p_folder: args.folder ?? null, p_source_message_ids: args.source_message_ids ?? [] })
      if (error) {
        const [status, code] = error.hint === 'workspace_version_conflict' ? [409, 'version_conflict']
          : /not a chat you are a member of|Not allowed to act as|permission denied/i.test(error.message) ? [403, 'denied'] : [400, 'invalid']
        throw new real.AttachmentsError('place', status, code, error.message)
      }
      return (data as Array<Record<string, unknown>>)[0]
    },
  }
})

const { createAppFiles } = await import('../../../apps/desktop/src/session/shared/extensions/app-files-core')

function agentFiles(w: World) {
  current = w
  removed.length = 0
  const files = createAppFiles({
    account: async () => ({ token: 'owner-token', userId: w.owner }),
    hasCapability: () => true,
    sync: { pageFor: () => ({}), grant: () => undefined, revoke: () => undefined, ungrant: () => undefined } as never,
    identities: async () => [],
    faces: async () => ({}),
    filesUrl: () => 'http://files.invalid',
    warn: () => undefined,
  })
  const surface = { pageId: -1, extensionId: 'workspace', itemId: null, asAgent: w.agent }
  const bytes = (data: string | number[]) => {
    const buffer = typeof data === 'string' ? Buffer.from(data) : Buffer.from(data)
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer
  }
  return { files, surface, bytes }
}
async function join(w: World): Promise<void> {
  await db.query("INSERT INTO chat.chat_members (chat_id,user_id,role) VALUES ($1,$2,'member')", [w.group, w.agent])
}

async function topicOf(source: string, creator: string): Promise<string> {
  await db.query('RESET role')
  const topic = randomUUID()
  const message = randomUUID()
  await db.query(`INSERT INTO chat.messages (id,chat_id,sender_user_id,content,content_type)
    VALUES ($1,$2,$3,'Topic source','text')`, [message, source, creator])
  await db.query(`INSERT INTO chat.chats (id,kind,name,creator_user_id,source_chat_id,source_message_id)
    VALUES ($1,'topic','Resource topic',$2,$3,$4)`, [topic, creator, source, message])
  await db.query("INSERT INTO chat.chat_members (chat_id,user_id,role) VALUES ($1,$2,'owner')", [topic, creator])
  return topic
}

describe('topic resources use the source container through the real App SDK and database', () => {
  it.each([false, true])('normal agent invitation joins the source; leaving the topic keeps source access (legacy participant=%s)', async (legacyParticipant) => {
    const w = await world()
    const topic = await topicOf(w.group, w.owner)
    if (legacyParticipant) await db.query("INSERT INTO chat.chat_members (chat_id,user_id,role) VALUES ($1,$2,'member')", [topic, w.agent])
    const { files } = agentFiles(w)
    const made = await files.create(w.group, { name: 'shared-with-invited-agent.md', content: 'Source membership' })
    await expect(files.groupFiles(topic, { asAgent: w.agent })).rejects.toMatchObject({ code: 'denied' })
    expect((await client.rpc('add_group_agent', { p_chat_id: topic, p_agent_user_id: w.agent, p_message: 'Join this topic', p_as_user_id: w.owner, p_as_task: false })).error).toBeNull()
    const seats = async () => (await db.query<{ chat_id: string }>('SELECT chat_id FROM chat.chat_members WHERE user_id=$1 AND chat_id=ANY($2::text[]) ORDER BY chat_id', [w.agent, [w.group, topic]])).rows.map((row) => row.chat_id).sort()
    expect(await seats()).toEqual([w.group, topic].sort())
    expect((await files.groupFiles(topic, { asAgent: w.agent })).map((entry) => entry.id)).toContain(made.id)
    expect((await client.rpc('remove_group_member_as', { p_chat_id: topic, p_member_user_id: w.agent, p_as_user_id: w.owner })).error).toBeNull()
    expect(await seats()).toEqual([w.group])
    expect((await files.groupFiles(w.group, { asAgent: w.agent })).map((entry) => entry.id)).toContain(made.id)
  })

  it.each(['group', 'dm', 'ai'] as const)('%s topics create/list/open the source file, and reject another source', async (kind) => {
    const w = await world()
    if (kind !== 'group') {
      const dm = randomUUID()
      await db.query('INSERT INTO chat.chats (id,kind,creator_user_id) VALUES ($1,$2,$3)', [dm, kind, w.owner])
      await db.query("INSERT INTO chat.chat_members (chat_id,user_id,role) VALUES ($1,$2,'owner'),($1,$3,'member')", [dm, w.owner, w.peer])
      w.group = dm
    }
    await join(w)
    const topic = await topicOf(w.group, w.owner)
    const other = await world()
    const otherTopic = await topicOf(other.group, other.owner)
    // The owner may see both sources, so a mismatched reference exercises container comparison, not invisibility.
    await db.query("INSERT INTO chat.chat_members (chat_id,user_id,role) VALUES ($1,$2,'member')", [other.group, w.owner])
    const { files, surface } = agentFiles(w)
    const made = await files.create(topic, { name: 'topic-notes.md', content: 'One resource container' }, { asAgent: w.agent })
    expect(made.chat).toBe(w.group)
    expect(await files.resourceChat(w.group, { asAgent: w.agent })).toBe(w.group)
    expect(await files.openTarget(surface, { ref: { chat: w.group, id: made.id } })).toMatchObject({ chatId: w.group, itemId: made.id })
    expect((await files.groupFiles(topic, { asAgent: w.agent })).map((entry) => entry.id)).toContain(made.id)
    expect(await files.openTarget(surface, { ref: { chat: topic, id: made.id } })).toMatchObject({ chatId: w.group, itemId: made.id })
    const person = { ...surface, asAgent: null }
    await expect(files.openTarget(person, { ref: { chat: otherTopic, id: made.id } })).rejects.toMatchObject({ code: 'invalid' })
    expect(await files.groupEntries(topic, [made.id], { asAgent: w.agent })).toMatchObject({ entries: [{ id: made.id, chat: w.group }], gone: [] })
    expect((await db.query('SELECT id FROM chat.workspace_items WHERE chat_id=$1', [topic])).rows).toEqual([])
    expect((await db.query('SELECT user_id FROM chat.chat_members WHERE chat_id=$1 AND user_id=$2', [topic, w.agent])).rows).toEqual([])
  })

  it('an agent in the source works with its owner outside; leaving the source removes file access', async () => {
    const w = await world(true)
    await join(w)
    const topic = await topicOf(w.group, w.peer)
    await db.query('DELETE FROM chat.chat_members WHERE chat_id=$1 AND user_id=$2', [w.group, w.owner])
    const { files, surface } = agentFiles(w)
    const made = await files.create(topic, { name: 'agent-source.md', content: 'Actor membership' }, { asAgent: w.agent })
    expect(await files.resourceChat(topic, { asAgent: w.agent })).toBe(w.group)
    const publicId = String((await db.query<{ public_id: number }>('SELECT public_id FROM chat.chats WHERE id=$1', [topic])).rows[0]!.public_id)
    for (const named of [topic, publicId]) {
      expect(await handedChatsAs(w.agent, [named])).toEqual([{ chatId: topic, resourceChatId: w.group, agentUserId: w.agent }])
    }
    expect(await files.openTarget(surface, { ref: { chat: topic, id: made.id } })).toMatchObject({ chatId: w.group })
    await db.query('DELETE FROM chat.chat_members WHERE chat_id=$1 AND user_id=$2', [w.group, w.agent])
    await expect(files.groupFiles(topic, { asAgent: w.agent })).rejects.toMatchObject({ code: 'denied' })
    await expect(files.openTarget(surface, { ref: { chat: topic, id: made.id } })).rejects.toMatchObject({ code: 'not-found' })
    for (const named of [topic, publicId]) await expect(handedChatsAs(w.agent, [named])).rejects.toThrow('not a chat you are in')
  })
})

describe('#6492 an App acting for an agent, against the migrated database', () => {
  it('主人在、agent 不在 ⇒ list / 按 id 找文件都拒;agent 入群后同一批读能读到', async () => {
    const w = await world()
    // A file owner made, written directly as the server (people write only through the doors since gugu-supabase 20261017083403).
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO chat.workspace_items (chat_id, kind, filename, inline_text, created_by) VALUES ($1,'document','Owner notes','OWNER-6492',$2) RETURNING id`,
      [w.group, w.owner],
    )
    await db.query('RESET role')
    const doc = rows[0]!.id
    const { files, surface } = agentFiles(w)
    // 库的拒绝原文随私聊放开(gugu-supabase #97)从「a group or topic」改成「a chat」:这里只核不变的那半句。
    await expect(files.groupFiles(w.group, { asAgent: w.agent })).rejects.toMatchObject({ code: 'denied', message: expect.stringMatching(/you are a member of/) })
    await expect(files.versions(surface, { ref: { id: doc } })).rejects.toMatchObject({ code: 'not-found' })

    await join(w)
    expect((await files.groupFiles(w.group, { asAgent: w.agent })).map((entry) => entry.id)).toEqual([doc])
    expect(await files.versions(surface, { ref: { id: doc } })).toEqual([])
  })

  it('*_as 按 uuid 查行:不是 uuid 的串与不存在同一句话;get_as 仍带正文给已发出的 MCP,其余只回元数据', async () => {
    const w = await world()
    await join(w)
    const { files, surface } = agentFiles(w)
    for (const bad of [randomUUID(), `${randomUUID()}' OR 1=1 --`]) {
      await expect(files.rename(surface, { ref: { id: bad }, name: 'x' })).rejects.toMatchObject({ code: 'not-found' })
    }
    const created = await files.create(w.group, { name: 'Plan', content: 'BODY-6492' }, { asAgent: w.agent })
    // 大写的 uuid 也是同一行(按 uuid 比,不按文本比)。
    expect(((await client.rpc('workspace_get_as', { p_item_id: created.id.toUpperCase(), p_as_user_id: w.agent })).data ?? [])[0]).toMatchObject({ id: created.id })
    const columnsOf = async (sql: string, values: unknown[]) => {
      await asUser(w.owner)
      const { fields } = await db.query(sql, values)
      await db.query('RESET role')
      return fields.map((field) => field.name).sort()
    }
    const meta = ['chat_id', 'content_type', 'created_at', 'created_by', 'filename', 'id', 'kind', 'pointer', 'size_bytes', 'source_message_ids', 'updated_at', 'version']
    // get_as also hands back the file's epoch: the agent opens <id>@<epoch> on the file service (gugu-supabase 20260929192000, F16).
    // 子文件夹(gugu-supabase 20261016012659)起 get / list 每行还带 parent_id / system_role / path:这两条只钉「至少有这些」,新旧库都过。
    expect(await columnsOf('SELECT * FROM chat.workspace_get_as($1, $2)', [created.id, w.agent])).toEqual(expect.arrayContaining([...meta, 'inline_text', 'epoch']))
    expect(await columnsOf('SELECT * FROM chat.workspace_list_as($1, $2)', [w.group, w.agent])).toEqual(expect.arrayContaining([...meta, 'total']))
    // 改名 = 原地 move(gugu-supabase 20261017083403 起 workspace_update_document_as 没了)。
    expect(await columnsOf('SELECT * FROM chat.workspace_move_as($1, $2, NULL, $3)', [created.id, w.agent, 'Plan 2'])).toEqual(expect.arrayContaining(meta))
    // 已发出的旧 MCP 只按名传前两个参数:list 照旧拿到全部行(只剩元数据),get 照旧带正文。
    await asUser(w.owner)
    const oldList = await db.query('SELECT * FROM chat.workspace_list_as(p_chat_id => $1, p_as_user_id => $2)', [w.group, w.agent])
    const oldGet = await db.query<{ inline_text: string }>('SELECT inline_text FROM chat.workspace_get_as(p_item_id => $1, p_as_user_id => $2)', [created.id, w.agent])
    await db.query('RESET role')
    expect(oldList.rows).toHaveLength(1)
    expect(oldGet.rows[0]?.inline_text).toBe('BODY-6492')
    const projected = await client.rpc('workspace_get_as', { p_item_id: created.id, p_as_user_id: w.agent }).select('id,filename')
    expect(projected.error).toBeNull()
    expect(projected.data).toEqual([{ id: created.id, filename: 'Plan 2' }])
  })

  it('workspace_list_as 在库里分页与筛选(已发出的 MCP 用它):总数、下一段、名字按字面(% _ 不是通配)、种类;按名字找文件也用它', async () => {
    const w = await world()
    await join(w)
    const { files, surface } = agentFiles(w)
    const names = ['100% done', 'a_b', 'axb', 'Notes']
    for (const name of names) await files.create(w.group, { name, content: '' }, { asAgent: w.agent })
    const list = async (args: Record<string, unknown>) =>
      ((await client.rpc('workspace_list_as', { p_chat_id: w.group, p_as_user_id: w.agent, ...args })).data ?? []) as Array<{ filename: string; total: string }>
    const first = await list({ p_offset: 0, p_limit: 3 })
    expect(first).toHaveLength(3)
    expect(Number(first[0]!.total)).toBe(4)
    expect(await list({ p_offset: 3, p_limit: 3 })).toHaveLength(1)
    expect(await list({ p_offset: 40, p_limit: 20 })).toEqual([])
    expect((await list({ p_name: '%' })).map((row) => row.filename)).toEqual(['100% done'])
    expect((await list({ p_name: '_' })).map((row) => row.filename)).toEqual(['a_b'])
    expect((await list({ p_name: 'NOTES' })).map((row) => row.filename)).toEqual(['Notes'])
    expect(await list({ p_kind: 'file' })).toEqual([])
    // The App names a file by its name through the same door: exactly that name, never the ILIKE neighbour.
    expect(await files.rename(surface, { ref: { chat: w.group, name: 'a_b' }, name: 'a_b.md' })).toMatchObject({ name: 'a_b.md' })
    expect((await files.groupFiles(w.group, { asAgent: w.agent })).map((entry) => entry.name).sort()).toEqual(['100% done', 'Notes', 'a_b.md', 'axb'])
  })

  it('建文件、改名(不动内容)、上传、给文件改名、删除:created_by 是 agent,来源消息记上;存成文件的是一份 blob,客户端不删字节', async () => {
    const w = await world()
    await join(w)
    const { files, surface, bytes } = agentFiles(w)
    const message = randomUUID()

    const created = await files.create(w.group, { name: 'Plan', content: 'v1', sourceMessageIds: [message] }, { asAgent: w.agent })
    expect(created).toMatchObject({ name: 'Plan', type: 'text', createdBy: { id: `user:${w.agent}` }, sourceMessageIds: [message] })
    expect(await files.rename(surface, { ref: { id: created.id }, name: 'Plan.md' })).toMatchObject({ id: created.id, name: 'Plan.md' })
    const body = await db.query('SELECT inline_text FROM chat.workspace_items WHERE id = $1', [created.id])
    expect(body.rows[0]?.inline_text).toBe('v1')
    const json = await files.create(w.group, { name: 'state.json', content: '{}', contentType: 'application/json' }, { asAgent: w.agent })
    // bigint 经 node-pg 回来是字符串,PostgREST 回的是数。
    expect(json).toMatchObject({ contentType: 'application/json' })
    expect(Number(json.size)).toBe(2)

    // 摩擦单 F19:文本类文件上传进来就是活文件(和新建同一种东西),不进桶。
    const [text] = await files.upload(w.group, [{ name: 'report.txt', contentType: '', bytes: bytes('abc') }], { asAgent: w.agent })
    expect(text).toMatchObject({ name: 'report.txt', contentType: 'text/plain', type: 'text', createdBy: { id: `user:${w.agent}` } })
    // 对照:二进制文件存成 file —— 字节是一份 blob(attachments/place),没有 pointer。下面的改名、删除都用它。
    const [stored] = await files.upload(w.group, [{ name: 'report.bin', contentType: '', bytes: bytes([0, 1, 2, 255]) }], { asAgent: w.agent, sourceMessageIds: [message] })
    expect(stored).toMatchObject({ name: 'report.bin', type: 'binary', createdBy: { id: `user:${w.agent}` }, sourceMessageIds: [message] })
    // pointer 按门回的读(gugu-supabase #150 起表上没有这一列,门照旧回、由 blob 推):新旧库都过。
    const held = (await db.query<{ blob_id: string | null }>('SELECT blob_id FROM chat.workspace_items WHERE id = $1', [stored!.id])).rows[0]!
    expect(held).toMatchObject({ blob_id: expect.any(String) })
    await asUser(w.owner)
    expect((await db.query<{ pointer: string | null }>('SELECT pointer FROM chat.workspace_get_as($1, $2)', [stored!.id, w.agent])).rows).toEqual([{ pointer: null }])
    await db.query('RESET role')

    // 改名和 mv 一样,二进制文件也能改;字节不动(还是那一份 blob)。
    expect(await files.rename(surface, { ref: { id: stored!.id }, name: 'final report.bin' })).toMatchObject({ name: 'final report.bin' })
    expect((await db.query('SELECT blob_id FROM chat.workspace_items WHERE id = $1', [stored!.id])).rows[0]?.blob_id).toBe(held.blob_id)

    // 删掉:字节没人用了由服务端回收,客户端一个对象都不删。
    await files.remove(surface, { ref: { id: stored!.id } })
    expect(removed).toEqual([])
    const left = await db.query('SELECT id FROM chat.workspace_items WHERE chat_id = $1 ORDER BY created_at, id', [w.group])
    expect(left.rows.map((row) => row.id).sort()).toEqual([created.id, json.id, text!.id].sort())
  })

  it('删别人建的 ⇒ denied,什么都不删:库在子文件夹迁移(gugu-supabase 20261016012659)起说人话、码在 HINT,之前说英文,两种都认', async () => {
    const w = await world()
    await join(w)
    // A file peer made, written directly as the server (people write only through the doors since gugu-supabase 20261017083403).
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO chat.workspace_items (chat_id, kind, filename, inline_text, created_by) VALUES ($1,'document','Peer notes','PEER-6492',$2) RETURNING id`,
      [w.group, w.peer],
    )
    await db.query('RESET role')
    const { files, surface } = agentFiles(w)
    await expect(files.remove(surface, { ref: { id: rows[0]!.id } })).rejects.toMatchObject({ code: 'denied' })
    expect((await db.query('SELECT id FROM chat.workspace_items WHERE id = $1', [rows[0]!.id])).rows).toHaveLength(1)
  })

  it('不在的群里上传 ⇒ 库里先拒,一个字节都不传', async () => {
    const w = await world()
    const { files, bytes } = agentFiles(w)
    staged.clear()
    await expect(files.upload(w.group, [{ name: 'leak.bin', contentType: '', bytes: bytes([1, 2]) }], { asAgent: w.agent }))
      .rejects.toMatchObject({ code: 'denied', message: expect.stringMatching(/you are a member of/) })
    expect(staged.size).toBe(0)
  })
})

/** G1(gugu-supabase 20261011011000):agent 的 edit(item_id, path)经 files.replace 换版本 —— 和人在 App 里换版本同一个 RPC。 */
describe('G1 files.replace acting for an agent: a stored file\'s next version', () => {
  it('同一个条目、version 2、历史两版(各是一份 blob);文本文件不换;删掉时客户端不删字节', async () => {
    const w = await world()
    await join(w)
    const { files, surface, bytes } = agentFiles(w)
    const [uploaded] = await files.upload(w.group, [{ name: 'deck.pptx', contentType: '', bytes: bytes([1, 2, 3]) }], { asAgent: w.agent })
    const blobOf = async () => (await db.query<{ blob_id: string }>('SELECT blob_id FROM chat.workspace_items WHERE id = $1', [uploaded!.id])).rows[0]!.blob_id
    const first = await blobOf()
    const replaced = await files.replace(surface, { ref: { id: uploaded!.id }, file: { name: '', contentType: '', bytes: bytes([4, 5, 6, 7]) }, expectedVersion: uploaded!.version })
    expect(replaced).toMatchObject({ id: uploaded!.id, name: 'deck.pptx', version: 2 })
    expect(Number(replaced.size)).toBe(4)
    const second = await blobOf()
    expect(second).not.toBe(first)
    const versions = await db.query<{ n: number; blob_id: string; made_by: string }>(
      'SELECT n, blob_id, made_by FROM chat.workspace_item_versions WHERE item_id = $1 ORDER BY n', [uploaded!.id])
    expect(versions.rows).toEqual([
      { n: 1, blob_id: first, made_by: w.agent },
      { n: 2, blob_id: second, made_by: w.agent },
    ])
    // 10-13 换版本要说清从哪一版改起:没说 ⇒ 拒,一个字节都不传;说的是旧版 ⇒ 库里拒,条目还是第 2 版。
    const before = staged.size
    await expect(files.replace(surface, { ref: { id: uploaded!.id }, file: { name: '', contentType: '', bytes: bytes([8]) }, expectedVersion: undefined }))
      .rejects.toMatchObject({ code: 'invalid', message: expect.stringMatching(/needs the version you started from/) })
    expect(staged.size).toBe(before)
    await expect(files.replace(surface, { ref: { id: uploaded!.id }, file: { name: '', contentType: '', bytes: bytes([8]) }, expectedVersion: 1 }))
      .rejects.toMatchObject({ code: 'content-changed', message: expect.stringMatching(/is version 2 now, not 1/) })
    expect(await blobOf()).toBe(second)
    // 文本文件不换版本:拒,说改用 edit
    const doc = await files.create(w.group, { name: 'Notes', content: 'x' }, { asAgent: w.agent })
    await expect(files.replace(surface, { ref: { id: doc.id }, file: { name: '', contentType: '', bytes: bytes([1]) }, expectedVersion: doc.version }))
      .rejects.toThrow(/live text file/)

    removed.length = 0
    await files.remove(surface, { ref: { id: uploaded!.id } })
    expect(removed).toEqual([])
  })
})
