/** #113 客户端 ↔ 库:项目记在账号上。客户端这一侧的真函数(publishDeviceProjects / listDeviceProjects)
 * 对着迁移完的库里**真的** identity.publish_device_projects 与 identity.device_projects:RPC 名、参数名、payload 形状、
 * 读的列名与读回来的形状,两边任一改动都在这里红。以主人身份(authenticated + JWT sub)在同一条连接上执行,
 * 与 PostgREST 同一个判权上下文(RLS、函数里的属主判断);表行按 PostgREST 的 JSON 写法交回(时间是 ISO 串)。
 * 每个用例回滚,只连 loopback。
 */
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  listDeviceProjects,
  publishDeviceProjects,
  type DeviceProject,
  type DeviceProjectsRpcClient,
  type DeviceProjectsTableClient,
} from '@gugu/core/cloud/deviceProjects'
import { ACCOUNT_REVISION_EVENTS, readDeviceRevision } from '../../../apps/desktop/src/lib/accountRevisionCoordinator'

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
    throw new Error('deviceProjects113 requires loopback PostgreSQL')
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
        VALUES ($1,'authenticated','authenticated',$2,'{}','{}',now(),now())`, [user, `${user}@113.example.invalid`])
      await db.query(`INSERT INTO identity.users (id,type,display_name) VALUES ($1,'human','113')
        ON CONFLICT (id) DO UPDATE SET display_name=EXCLUDED.display_name`, [user])
      await db.query(`INSERT INTO identity.gugu_devices (device_id,user_id,label,hostname,platform)
        VALUES ($1,$2,'113','113','darwin')`, [device, user])
    }
    await body(ids)
  } finally { await db.query('ROLLBACK') }
}

/** 以 `user` 的身份跑一句,失败回滚到调用前、错误原文交回(同 PostgREST 把 RAISE 的原文放进 error.message)。 */
async function asUser<Row>(user: string, sql: string, values: unknown[]): Promise<{ rows: Row[] } | { error: string }> {
  await db.query('SAVEPOINT as_user')
  try {
    await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: user, role: 'authenticated' })])
    await db.query('SET LOCAL ROLE authenticated')
    const result = await db.query<Row>(sql, values)
    await db.query('RESET ROLE')
    await db.query('RELEASE SAVEPOINT as_user')
    return result
  } catch (error) {
    await db.query('ROLLBACK TO SAVEPOINT as_user')
    await db.query('RESET ROLE')
    return { error: (error as Error).message }
  }
}

/** 客户端拿到的 identity schema 客户端,换成以 `user` 身份直连库:只认这两条路,别的当场报错。 */
function clientAs(user: string): DeviceProjectsRpcClient & DeviceProjectsTableClient {
  return {
    async rpc(fn, args) {
      if (fn !== 'publish_device_projects') throw new Error(`unexpected rpc ${fn}`)
      const result = await asUser<{ result: unknown }>(user,
        'SELECT identity.publish_device_projects(p_device_id => $1, p_projects => $2::jsonb) AS result',
        [args.p_device_id, JSON.stringify(args.p_projects)])
      return 'error' in result ? { data: null, error: { message: result.error } } : { data: result.rows[0]?.result, error: null }
    },
    from(table) {
      if (table !== 'device_projects') throw new Error(`unexpected table ${table}`)
      return {
        select(columns, options) {
          if (!/^[a-z_, ]+$/.test(columns)) throw new Error(`bad select ${columns}`)
          if (options.count !== 'exact') throw new Error('expected an exact count')
          return {
            eq(column, value) {
              const order: string[] = []
              let ids: readonly string[] | null = null
              // PostgREST 的 in / order / range / count=exact:同一个判权上下文里筛好、排好、切一页、数总行数。
              const page = {
                in(inColumn: 'device_id', values: readonly string[]) {
                  if (inColumn !== 'device_id') throw new Error(`unexpected in ${inColumn}`)
                  ids = values
                  return page
                },
                order(by: 'device_id' | 'local_project_id') {
                  order.push(by)
                  return page
                },
                async range(from: number, to: number) {
                  const where = `FROM identity.device_projects WHERE ${column} = $1 AND ($2::text[] IS NULL OR device_id = ANY($2))`
                  const rows = await asUser<{ row: unknown }>(user,
                    `SELECT to_jsonb(picked) AS row FROM (SELECT ${columns} ${where} ORDER BY ${order.join(', ')} OFFSET $3 LIMIT $4) AS picked`,
                    [value, ids, from, to - from + 1])
                  if ('error' in rows) return { data: null, error: { message: rows.error }, count: null }
                  const counted = await asUser<{ count: number }>(user, `SELECT count(*)::int AS count ${where}`, [value, ids])
                  if ('error' in counted) return { data: null, error: { message: counted.error }, count: null }
                  return { data: rows.rows.map((r) => r.row), error: null, count: counted.rows[0]?.count ?? null }
                },
              }
              return page
            },
          }
        },
      }
    },
  }
}

const projects = (chatId: string): DeviceProject[] => [
  {
    localProjectId: 'proj-new',
    name: 'repo',
    rootPath: '/srv/repo',
    createdAt: '2026-10-05T09:30:00.000Z',
    chatId,
    groupRepresentative: true,
    folders: [
      { workspaceId: 'ws-root', kind: 'root', path: '/srv/repo', attachedAt: null },
      { workspaceId: 'ws-wt', kind: 'attached', path: '/srv/repo-wt', attachedAt: '2026-10-06T00:00:00.000Z' },
    ],
  },
  {
    localProjectId: '00000000-0000-4000-8000-000000000001',
    name: '任务工作区',
    rootPath: '/home/u/.gugu/task-home',
    createdAt: '2026-10-01T08:00:00.000Z',
    chatId: null,
    groupRepresentative: false,
    folders: [{ workspaceId: 'ws-home', kind: 'root', path: '/home/u/.gugu/task-home', attachedAt: null }],
  },
]

describe('#113 项目记在账号上:客户端写的那份,库收得下、读回来一模一样', () => {
  it('整份记上去,别的端读回来与写的相同(新建的在前);再写同一份不算变化;只推进一个客户端认得的 revision', async () => {
    await rollback(async ({ owner, device }) => {
      const head = async () => (await db.query<{ revision: string }>(
        'SELECT revision::text FROM chat.account_revision_heads WHERE user_id = $1', [owner])).rows[0]?.revision ?? '0'
      const before = await head()
      const written = projects(randomUUID())
      await expect(publishDeviceProjects(clientAs(owner), device, written)).resolves.toBe(true)
      await expect(listDeviceProjects(clientAs(owner), owner)).resolves.toEqual({ [device]: written })

      const after = await head()
      expect(BigInt(after)).toBe(BigInt(before) + 1n)
      await expect(publishDeviceProjects(clientAs(owner), device, written)).resolves.toBe(false)
      expect(await head()).toBe(after)

      const { rows } = await db.query<{ event: string; resource_key: unknown }>(
        'SELECT event, resource_key FROM chat.account_revisions WHERE user_id = $1 AND revision = $2::bigint', [owner, after])
      expect(rows[0]?.resource_key).toEqual({ device_id: device, kind: 'projects' })
      expect(ACCOUNT_REVISION_EVENTS).toContain(rows[0]?.event)
      // 客户端读得懂:只读这一台的项目,不读设备行。
      expect(readDeviceRevision({ ...(rows[0]?.resource_key as object), tombstone: false })).toEqual({ deviceId: device, row: false, projects: true, removed: false })
    })
  })

  it('别人的设备写不进去、别人读不到这份;对照:主人自己读得到', async () => {
    await rollback(async ({ owner, other, device, otherDevice }) => {
      await expect(publishDeviceProjects(clientAs(owner), otherDevice, projects(randomUUID()))).rejects.toThrow(/not owned/)
      await publishDeviceProjects(clientAs(owner), device, projects(randomUUID()))
      expect(Object.keys(await listDeviceProjects(clientAs(owner), owner))).toEqual([device])
      await expect(listDeviceProjects(clientAs(other), owner)).resolves.toEqual({})
      await expect(listDeviceProjects(clientAs(other), other)).resolves.toEqual({})
    })
  })
})
