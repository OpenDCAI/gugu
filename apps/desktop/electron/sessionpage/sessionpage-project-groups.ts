// @@@sessionpage TASKPAGE-FUSION — 「这个项目对应哪个群」的持久映射(spec ⑨:项目 = 群)。
//
// 为什么单独存一份:映射原本只写在每条 agent roster 记录的 cache 上(project→group),于是项目里最后一个
// agent 被摘掉时映射也跟着消失 —— 同一个项目下一次开会话就又建一个新群,owner 眼里同名群越攒越多
// (实机上确实攒出了两个同名的 `new project` 群)。群的寿命属于**项目**,不属于某个 agent 实例,所以它
// 得存在与 agent 生命周期无关的地方。
//
// 只在本机存:群本身在云端,这份文件只是「项目 id → 群 id」的索引。丢了不致命(退化成 roster 兜底、
// 最坏是新建一个群),所以读取路径对坏文件宽容;写入路径原子落盘,避免半截 JSON。
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWriteText, resolveGuguHome } from '@gugu/core/local/state/paths'
import { fileRefKey, requireFileRevision, type FileRef, type FileRevision } from '@gugu/core/shared/fileResolver'
import { createLogger } from '../lib/logger'

const FILE_NAME = 'taskpage-project-groups.json'

function filePath(env: NodeJS.ProcessEnv): string {
  return join(resolveGuguHome(env), FILE_NAME)
}

// #4277 —— 群归**账号**:A 建的群 B 进不去(RLS),所以「项目 → 群」得按账号分区,B 在同一项目有自己的
// 群。文件形状 v2:`{ owners: { <uid>: { <projectId>: <chatId> } }, unowned: { <projectId>: <chatId> } }`;
// `unowned` 装 v1 平铺时代不知道归谁的条目,由第一个能看见那个群的账号认领(见 readProjectGroupId
// 的两段读法与 rememberProjectGroupId 的顺手清理)。
type ProjectMap = Record<string, string>
interface Mapping {
  owners: Record<string, ProjectMap>
  unowned: ProjectMap
  /** This machine's visible row for a group containing more than one local project. */
  representatives: Record<string, ProjectMap>
  files?: Record<string, Record<string, FileRevision>>
}

function replaceRepresentative(projects: ProjectMap, representatives: ProjectMap, chatId: string, removedId: string): void {
  if (representatives[chatId] !== removedId) return
  const next = Object.keys(projects).filter((id) => id !== removedId && projects[id] === chatId).sort()[0]
  if (next) representatives[chatId] = next
  else delete representatives[chatId]
}

function readProjectMap(source: unknown): ProjectMap {
  const out: ProjectMap = {}
  if (!source || typeof source !== 'object' || Array.isArray(source)) return out
  for (const [projectId, chatId] of Object.entries(source as Record<string, unknown>)) {
    if (projectId && typeof chatId === 'string' && chatId) out[projectId] = chatId
  }
  return out
}

function parseMapping(parsed: unknown): Mapping {
  const empty: Mapping = { owners: {}, unowned: {}, representatives: {} }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return empty
  const raw = parsed as Record<string, unknown>
  if (raw.owners && typeof raw.owners === 'object' && !Array.isArray(raw.owners)) {
    const owners: Record<string, ProjectMap> = {}
    for (const [ownerId, map] of Object.entries(raw.owners as Record<string, unknown>)) {
      if (ownerId) owners[ownerId] = readProjectMap(map)
    }
    const representatives: Record<string, ProjectMap> = {}
    if (raw.representatives && typeof raw.representatives === 'object' && !Array.isArray(raw.representatives)) {
      for (const [ownerId, map] of Object.entries(raw.representatives as Record<string, unknown>)) {
        if (ownerId) representatives[ownerId] = readProjectMap(map)
      }
    }
    return { owners, unowned: readProjectMap(raw.unowned), representatives, files: raw.files as Mapping['files'] }
  }
  // v1:整份文件就是一张 { projectId: chatId },归属未知。
  return { owners: {}, unowned: readProjectMap(raw), representatives: {} }
}

async function readMapping(env: NodeJS.ProcessEnv): Promise<Mapping> {
  try {
    return parseMapping(JSON.parse(await readFile(filePath(env), 'utf8')) as unknown)
  } catch (error) {
    // 首次运行没有这个文件 = 正常,静默。
    if ((error as { code?: string } | null)?.code === 'ENOENT') return { owners: {}, unowned: {}, representatives: {} }
    // 其它读失败(坏 JSON / 权限 / IO)绝不能静默当空:那样恰好复现这份文件要防的 bug —— 同项目
    // 再开会话时查不到群 → 又建一个同名群。降级仍然继续(群在云端,不至于卡死),但必须喊出来。
    console.error(
      `[sessionpage] SESSIONPAGE-FUSION: 读不动「项目→群」映射 ${filePath(env)} —— 本次按「无映射」处理,同一项目可能被重复建群`,
      error,
    )
    return { owners: {}, unowned: {}, representatives: {} }
  }
}

async function writeMapping(mapping: Mapping, env: NodeJS.ProcessEnv): Promise<void> {
  const owners: Record<string, ProjectMap> = {}
  for (const [ownerId, map] of Object.entries(mapping.owners)) {
    if (Object.keys(map).length) owners[ownerId] = map
  }
  await atomicWriteText(filePath(env), `${JSON.stringify({ owners, unowned: mapping.unowned, representatives: mapping.representatives, files: mapping.files }, null, 2)}\n`)
}

// 同一个 main 进程里可能有多个会话同时 provision(实机:一个项目里连开两个任务)。read-modify-write
// 不串行化 = 后写覆盖先写、丢掉另一个项目的条目 → 那个项目下次又建新群。用一条 promise 链把所有
// 变更排队(❌ 各自读改写)。
//
// #7341 这条队列是这份文件**唯一**的写口:写者(供给、回收器、项目群绑定)全在宿主这一侧、import 的都是本模块;
// 会话页那一侧只读(app-given.ts)。❌ 在会话页树里另 import 本模块来写 —— 要写就经宿主注入的 ProjectGroupHost。
let writeQueue: Promise<void> = Promise.resolve()
function enqueue(mutate: () => Promise<void>): Promise<void> {
  const next = writeQueue.then(mutate, mutate)
  writeQueue = next.catch(() => {})
  return next
}

// #7341 第二步:绑定(项目 → 群)是跨设备的项目身份,渲染层按它把各台机器的项目合成一行 —— 变了得让它重读。
// 谁写的都算(新会话建了群、回收器忘了一条、用户并进来 / 撤销),所以挂在唯一的写口上,❌ 每个写者各自去发。
type MappingChangeListener = (change: { projectId: string; ownerUserId: string }) => void
const changeListeners = new Set<MappingChangeListener>()
const log = createLogger('sessionpage/project-groups')

/** 「项目 → 群」对照真的改了(写进了文件)就叫一声。返回退订。 */
export function onProjectGroupMappingChanged(listener: MappingChangeListener): () => void {
  changeListeners.add(listener)
  return () => changeListeners.delete(listener)
}

function announceChange(projectId: string, ownerUserId: string): void {
  for (const listener of changeListeners) {
    // 听的人出错不能把这次写入变成失败:文件已经落盘了。
    try {
      listener({ projectId, ownerUserId })
    } catch (error) {
      log.error({ projectId, err: error }, '#7341 a listener of project→group mapping changes threw — the write itself landed')
    }
  }
}

/**
 * 这个会话页项目在**这个账号**名下已经有对应的 gugu 群吗?返回 chatId,没有则 null。
 *
 * 账号自己的条目优先;没有时退回 v1 时代不知道归谁的条目 —— 调用方拿它去云端问一句「还在吗」,
 * 看得见就用 rememberProjectGroupId 认领到自己名下,看不见(别家的群,RLS 挡着)就当没有、自己建。
 */
export async function readProjectGroupId(
  projectId: string,
  ownerUserId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const id = projectId.trim()
  if (!id) return null
  const mapping = await readMapping(env)
  return mapping.owners[ownerUserId]?.[id] ?? mapping.unowned[id] ?? null
}

/** 记住「这个账号名下,项目 → 群」。同一项目重复写入同一个群是幂等的;认领走的是 v1 条目就顺手清掉它。 */
export async function rememberProjectGroupId(
  projectId: string,
  chatId: string,
  ownerUserId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const id = projectId.trim()
  const chat = chatId.trim()
  if (!id || !chat || !ownerUserId) return
  await enqueue(async () => {
    const mapping = await readMapping(env)
    const mine = mapping.owners[ownerUserId] ?? {}
    const representatives = mapping.representatives[ownerUserId] ?? {}
    const adopted = mapping.unowned[id] === chat
    if (mine[id] === chat && !adopted && representatives[chat]) return
    const oldChat = mine[id]
    if (oldChat && oldChat !== chat) invalidateProjectFiles(mapping, ownerUserId, id)
    if (oldChat && oldChat !== chat) replaceRepresentative(mine, representatives, oldChat, id)
    mine[id] = chat
    mapping.owners[ownerUserId] = mine
    if (!representatives[chat]) representatives[chat] = id
    mapping.representatives[ownerUserId] = representatives
    if (adopted) delete mapping.unowned[id]
    await writeMapping(mapping, env)
    announceChange(id, ownerUserId)
  })
}

/** 项目没了(群已归档)→ 这个账号忘掉它,别让下一次查询复用一个归档群。归档的若是 v1 条目也一并忘。 */
export async function forgetProjectGroupId(
  projectId: string,
  ownerUserId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const id = projectId.trim()
  if (!id) return
  await enqueue(async () => {
    const mapping = await readMapping(env)
    const mine = mapping.owners[ownerUserId]
    const hadMine = Boolean(mine && id in mine)
    const hadUnowned = id in mapping.unowned
    if (!hadMine && !hadUnowned) return
    const chatId = mine?.[id]
    const representatives = mapping.representatives[ownerUserId]
    if (chatId && representatives) replaceRepresentative(mine ?? {}, representatives, chatId, id)
    if (mine) delete mine[id]
    invalidateProjectFiles(mapping, ownerUserId, id)
    delete mapping.unowned[id]
    await writeMapping(mapping, env)
    announceChange(id, ownerUserId)
  })
}

function invalidateProjectFiles(mapping: Mapping, ownerId: string, projectId: string): void {
  for (const [id, revision] of Object.entries(mapping.files?.[ownerId] ?? {})) {
    if (revision.host_project_id === projectId) delete mapping.files![ownerId]![id]
  }
}

/** Published local revisions share the account/project mapping and its sole atomic write queue. */
export async function rememberProjectFile(revision: FileRevision, ownerId: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  requireFileRevision(revision)
  if (revision.source !== 'local' || revision.host_account_id !== ownerId || !revision.chat_id) throw new Error('File owner or group mismatch')
  await enqueue(async () => {
    const mapping = await readMapping(env)
    if (mapping.owners[ownerId]?.[revision.host_project_id!] !== revision.chat_id) throw new Error('Project binding changed')
    // Roots are resolved from the project registry at read time, never copied into this index.
    const { source, item_id, version, chat_id, file_name, content_type, size_bytes, sha256, host_device_id, host_project_id, host_account_id, relative_path, workspace } = revision
    mapping.files ??= {}
    mapping.files[ownerId] ??= {}
    mapping.files[ownerId]![item_id!] = { source, item_id, version, chat_id, file_name, content_type, size_bytes, sha256, host_device_id, host_project_id, host_account_id, relative_path, ...(workspace ? { workspace } : {}) }
    await writeMapping(mapping, env)
  })
}

export async function findProjectFileByName(chat: string, name: string, ownerId: string, deviceId: string, env: NodeJS.ProcessEnv = process.env) {
  const files = Object.values((await readMapping(env)).files?.[ownerId] ?? {})
  const found = files.find(row => row.chat_id === chat && row.workspace?.path === name)
  return found ? readProjectFile({ item_id: found.item_id! }, ownerId, deviceId, env) : null
}

export async function findProjectFileCopy(projectId: string, sha: string, ownerId: string, deviceId: string, env: NodeJS.ProcessEnv = process.env) {
  const files = Object.values((await readMapping(env)).files?.[ownerId] ?? {})
  const found = files.find(row => row.host_project_id === projectId && row.sha256 === sha && row.relative_path?.startsWith('.gugu/attachments/'))
  return found ? readProjectFile({ item_id: found.item_id! }, ownerId, deviceId, env) : null
}

export async function readProjectFile(ref: FileRef, ownerId: string, deviceId: string, env: NodeJS.ProcessEnv = process.env): Promise<FileRevision | null> {
  fileRefKey(ref)
  if (!('item_id' in ref) || !ownerId || !deviceId) return null
  const mapping = await readMapping(env)
  const mine = mapping.files?.[ownerId]
  const revision = mine && Object.hasOwn(mine, ref.item_id) ? mine[ref.item_id] : undefined
  if (!revision) return null
  requireFileRevision(revision)
  if (!revision.chat_id || revision.host_account_id !== ownerId || revision.host_device_id !== deviceId || revision.item_id !== ref.item_id ||
    mapping.owners[ownerId]?.[revision.host_project_id!] !== revision.chat_id || ref.version !== undefined && ref.version !== revision.version) return null
  return revision
}

export async function forgetProjectFile(itemId: string, ownerId: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  await enqueue(async () => {
    const mapping = await readMapping(env)
    if (!Object.hasOwn(mapping.files?.[ownerId] ?? {}, itemId)) return
    delete mapping.files![ownerId]![itemId]
    await writeMapping(mapping, env)
  })
}

/**
 * 这个账号名下记过的全部「项目 → 群」。回收器用它当群投影的枚举面:项目没了、群还挂在映射里,就该
 * 归档 —— 哪怕那个项目的 agent 名册行早已一条不剩(以前只从名册行推「死项目的群」,名册一空这些群就
 * 永远收不到,spec「删除必同步」在群这一半也是漏的)。只回自己名下的条目:v1 的 unowned 条目归属未知,
 * 交给 readProjectGroupId 的认领路径。
 */
export async function listProjectGroupIds(
  ownerUserId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Array<{ projectId: string; chatId: string; representative: boolean }>> {
  if (!ownerUserId) return []
  const mapping = await readMapping(env)
  const representatives = mapping.representatives[ownerUserId] ?? {}
  return Object.entries(mapping.owners[ownerUserId] ?? {}).map(([projectId, chatId]) => ({
    projectId, chatId, representative: representatives[chatId] === projectId,
  }))
}
