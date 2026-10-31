import { createGroupAdmin } from '@gugu/core/cloud/groupAdmin'
// #7341 第二步 —— 项目跨设备(product spec「挂文件夹」,session-page-comm「项目 = 群」)。
//
// 项目的跨设备身份就是它的项目群:每台机器各有自己的本地项目(id 各不相同),绑在同一个群上的本地项目 = 同一个项目。
// 绑定记在本机那份「项目 → 群」对照里(sessionpage-project-groups.ts,按账号分区)。这个模块是会话页 `projects.*`
// 那四个操作在宿主这一侧的实现(会话页经 setProjectGroupHost 接上):
//   · 读:这台机器、当前账号下每个本地项目绑的群。
//   · 建群:项目还没有群 ⇒ 当场在云端建一个只有群主的群(product spec「建项目那一刻群就建好」,gugu-dev#181;
//     云端 #8 起允许只有群主一个人的群)。老版本只预留了 id、云端还没建出来的,也在这一步按那个 id 建。
//   · 并进来(owner 2026-10-17 选 A):这个项目里的 agent 都加进那个群(chat.add_group_agent,与「把自己的 agent 拉进群」
//     同一个入口),名册里钉着的群改成它;原来的群不删不归档,留作历史。
//   · 撤销:忘掉对照,agent 在名册里钉回并进来之前的群;已经加进那个群的 agent 留在里面。
//
// 与开会话共用供给锁(withSessionpageProvisionLock):两边都读改写对照与名册里的群,背靠背发生时不排队就会各记各的。
// 对照的写只经 sessionpage-project-groups.ts 的那一条队列 —— 本模块与供给、回收器都 import 同一个模块,❌ 另写一份。
import { randomUUID } from 'node:crypto'
import { listAgents, updateAgent, type LocalAgentRecord } from '@gugu/core'
import { err, ok, type Result } from '@gugu/session-shared'
import type {
  BindProjectToGroupResult,
  ProjectGroupBinding,
  ProjectGroupError,
} from '../../src/session/shared/core/projects/project-groups'
import type { ProjectGroupHost, ProjectGroupSubject } from '../session/main/core/projects/project-group-host'
import { createLogger } from '../lib/logger'
import { makeChatClient } from '../supabase'
import {
  GROUP_CACHE_KEY,
  OWNER_CACHE_KEY,
  PROJECT_CACHE_KEY,
  SESSION_CACHE_KEY,
  cacheString,
  findGroupIdForProject,
  groupProjectIdFor,
  isUniqueViolation,
  projectGroupDisplayName,
  sessionpageCloudIdentityState,
  settleSessionpageAgentBackgroundWork,
  withSessionpageProvisionLock,
} from './emdash-agent-provisioning'
import {
  forgetProjectGroupId,
  listProjectGroupIds,
  readProjectGroupId,
  rememberProjectGroupId,
} from './sessionpage-project-groups'

/**
 * 并进来之前这个 agent 在名册里钉着哪个群(没有群 = '')。撤销靠它把 agent 钉回去 —— 只忘对照不够:新会话找群时
 * 对照没有就退回名册里同项目 agent 钉着的群(findGroupIdForProject),名册不改回来,撤销等于没撤。
 */
export const GROUP_BEFORE_BIND_CACHE_KEY = 'sessionpage_group_chat_before_bind'

export interface SessionpageProjectGroupHostDeps {
  getAuth: () => Promise<{ accessToken: string; userId: string } | null>
  env?: NodeJS.ProcessEnv
}

type ChatClient = ReturnType<typeof makeChatClient>
type GroupState = 'active' | 'missing' | 'archived' | 'not-a-group' | 'not-member'

const log = createLogger('sessionpage/project-groups')

const notSignedIn = (): ProjectGroupError => ({ type: 'not-signed-in', message: '这台机器上没有登录咕咕账号' })

/** 云端那一发失败(读群、建群、加人)。只有它变成 `cloud-failed`;本机读写名册 / 对照出错照常抛,❌ 冒充云端失败。 */
class ProjectGroupCloudError extends Error {}

async function cloudFailedOr<T>(work: () => Promise<Result<T, ProjectGroupError>>): Promise<Result<T, ProjectGroupError>> {
  try {
    return await work()
  } catch (error) {
    if (error instanceof ProjectGroupCloudError) return err({ type: 'cloud-failed', message: error.message })
    throw error
  }
}

/**
 * 这个群对当前账号来说能不能当项目群用。看不见的群(不存在、或别人的群 —— RLS 让两者同形)= 'missing';
 * 查询出错就抛(❌ 当成「没有」去另记一个群)。
 */
async function readGroupState(chat: ChatClient, chatId: string, ownerUserId: string): Promise<GroupState> {
  const { data, error } = await chat.from('chats').select('id, kind, status').eq('id', chatId).maybeSingle()
  if (error) throw new ProjectGroupCloudError(`read group ${chatId}: ${error.message}`)
  if (!data) return 'missing'
  const row = data as { kind?: string | null; status?: string | null }
  if (row.kind !== 'group') return 'not-a-group'
  if (row.status === 'archived') return 'archived'
  const { data: me, error: meError } = await chat
    .from('active_members')
    .select('user_id')
    .eq('chat_id', chatId)
    .eq('user_id', ownerUserId)
    .maybeSingle()
  if (meError) throw new ProjectGroupCloudError(`read membership of group ${chatId}: ${meError.message}`)
  return me ? 'active' : 'not-member'
}

/** 这个本地项目的 agent:它没归档的会话绑着的、归当前账号的名册行(别的账号停放在这里的不算)。 */
function projectAgents(roster: LocalAgentRecord[], subject: ProjectGroupSubject, ownerUserId: string): LocalAgentRecord[] {
  const live = new Set(subject.sessionIds)
  return roster.filter((agent) => {
    if (!agent.gugu_user_id) return false
    if (!live.has(cacheString(agent.cache, SESSION_CACHE_KEY))) return false
    const owner = cacheString(agent.cache, OWNER_CACHE_KEY)
    return !owner || owner === ownerUserId
  })
}

/**
 * 建一个只有群主的项目群,答它建完之后的样子:建成 = 'active';这个 id 刚被别处建出来(第一个会话抢先)= 按云端读到的
 * 答(当前账号在里面就是 'active',别人的群照 RLS 读成 'missing')。
 */
async function createOwnerOnlyGroup(chat: ChatClient, chatId: string, name: string, ownerUserId: string): Promise<GroupState> {
  const { error } = await chat.rpc('create_gugu_group', {
    p_chat_id: chatId,
    p_name: name,
    p_owner_user_id: ownerUserId,
    p_initial_members: [],
    p_default_agent_type: null,
    p_group_prompt: null,
  })
  if (!error) return 'active'
  if (!isUniqueViolation(error)) throw new ProjectGroupCloudError(`create project group ${chatId}: ${error.message}`)
  return readGroupState(chat, chatId, ownerUserId)
}

/** The trusted caller binding supplies the owner's acting agent. Membership lets it announce a
 * project change; it does not move its session, change its pinned project/group or start an agent.
 * `founding`: the agent just created this project (project_create). The group is created with the project and
 * holds only the owner (gugu-dev#181), so the creator takes its seat here; any other absent agent is refused. */
export async function ensureProjectNoticeAccess(
  auth: { accessToken: string; userId: string },
  agentUserId: string,
  project: { projectId: string; projectName: string; chatId: string },
  { founding = false }: { founding?: boolean } = {},
): Promise<void> {
  const chat = makeChatClient(auth.accessToken)
  const { chatId } = project
  let state = await readGroupState(chat, chatId, auth.userId)
  if (state === 'missing') {
    const { error } = await chat.rpc('create_gugu_group', {
      p_chat_id: chatId,
      p_name: projectGroupDisplayName(project.projectName, project.projectId),
      p_owner_user_id: auth.userId,
      p_initial_members: [{ user_id: agentUserId, role: 'member' }],
      p_default_agent_type: null,
      p_group_prompt: null,
    })
    if (error && !isUniqueViolation(error)) throw new ProjectGroupCloudError(error.message)
    state = await readGroupState(chat, chatId, auth.userId)
  }
  if (state !== 'active') throw new ProjectGroupCloudError(`项目群不可用: ${state}`)
  const member = await chat.from('active_members').select('user_id').eq('chat_id', chatId).eq('user_id', agentUserId).maybeSingle()
  if (member.error) throw new ProjectGroupCloudError(member.error.message)
  if (member.data) return
  if (!founding) throw new ProjectGroupCloudError('操作 agent 已不在项目群中；明确重新加入后才能发布群通知')
  const joined = await createGroupAdmin(chat, auth.userId).addAgent(chatId, agentUserId, { asTask: true })
    .catch((error: Error) => { throw new ProjectGroupCloudError(error.message) })
  if (joined.status === 'pending_approval') throw new ProjectGroupCloudError('项目群开了「Agent 加入需审批」,创建项目的 agent 等群主同意后才能发布群通知')
}

export function createSessionpageProjectGroupHost(deps: SessionpageProjectGroupHostDeps): ProjectGroupHost {
  const env = (): NodeJS.ProcessEnv => deps.env ?? process.env

  /** 登录态 + 这个项目有没有项目群可言(云电脑 / 隐式项目没有,见 groupProjectIdFor)。 */
  async function ownerFor(
    subject: ProjectGroupSubject,
    refusal: (message: string) => ProjectGroupError,
  ): Promise<Result<{ accessToken: string; userId: string }, ProjectGroupError>> {
    if (!groupProjectIdFor(subject.projectId, env())) {
      return err(refusal(
        env().GUGU_CLOUD_COMPUTER === '1'
          ? '云电脑上的项目不建项目群:那里的 agent 只和主人私聊'
          : `项目「${subject.projectName}」不建项目群(还没打开仓库的会话不属于任何项目)`,
      ))
    }
    const auth = await deps.getAuth()
    if (!auth?.accessToken || !auth.userId) return err(notSignedIn())
    return ok({ accessToken: auth.accessToken, userId: auth.userId })
  }

  async function listBindings(projectIds: readonly string[]): Promise<Result<ProjectGroupBinding[], ProjectGroupError>> {
    // 云电脑上的项目不建群(groupProjectIdFor):这台机器上就没有绑定,是真的空。
    if (env().GUGU_CLOUD_COMPUTER === '1') return ok([])
    const auth = await deps.getAuth()
    if (!auth?.userId) return err(notSignedIn())
    const mapped = new Map((await listProjectGroupIds(auth.userId, env())).map((entry) => [entry.projectId, entry]))
    // 老数据只把群记在名册行上(对照是后来才有的):对照里没有就照第一个会话找群时的口径退回名册。
    const roster = await listAgents(env(), { includeGuests: true })
    const bindings: ProjectGroupBinding[] = []
    for (const projectId of projectIds) {
      if (!groupProjectIdFor(projectId, env())) continue
      const entry = mapped.get(projectId)
      const chatId = entry?.chatId || findGroupIdForProject(roster, projectId, auth.userId)
      if (chatId) bindings.push({ projectId, chatId })
    }
    return ok(bindings)
  }

  async function ensureGroup(subject: ProjectGroupSubject): Promise<Result<{ chatId: string; changed: boolean }, ProjectGroupError>> {
    const owner = await ownerFor(subject, (message) => ({ type: 'not-found', message }))
    if (!owner.success) return owner
    const { accessToken, userId } = owner.data
    const { projectId } = subject
    const chat = makeChatClient(accessToken)
    const name = projectGroupDisplayName(subject.projectName, projectId)
    return cloudFailedOr(() => withSessionpageProvisionLock(`project-group ensure ${projectId}`, async () => {
      const recorded = await readProjectGroupId(projectId, userId, env())
      const roster = await listAgents(env(), { includeGuests: true })
      const mapped = recorded || findGroupIdForProject(roster, projectId, userId) || ''
      if (mapped) {
        let state = await readGroupState(chat, mapped, userId)
        // 'missing' = 老版本预留的、云端还没建出来的群:就按这个 id 建。
        if (state === 'missing') state = await createOwnerOnlyGroup(chat, mapped, name, userId)
        if (state === 'active') {
          await rememberProjectGroupId(projectId, mapped, userId, env())
          return ok({ chatId: mapped, changed: recorded !== mapped })
        }
        // 归档了 / 不是群 / 这个账号已不在里面:与第一个会话遇到同样情形时一样,忘掉它、另起一个。
        log.info({ projectId, chatId: mapped, state }, '#7341 mapped project group is unusable — creating a fresh one')
        await forgetProjectGroupId(projectId, userId, env())
      }
      const chatId = randomUUID()
      const state = await createOwnerOnlyGroup(chat, chatId, name, userId)
      if (state !== 'active') throw new ProjectGroupCloudError(`new project group ${chatId} is ${state} right after creation`)
      await rememberProjectGroupId(projectId, chatId, userId, env())
      log.info({ projectId, chatId }, '#181 created the project group (owner only)')
      return ok({ chatId, changed: true })
    }))
  }

  async function bindToGroup(
    subject: ProjectGroupSubject,
    rawChatId: string,
    expectedChatId?: string | null,
  ): Promise<Result<BindProjectToGroupResult & { changed: boolean }, ProjectGroupError>> {
    const chatId = rawChatId.trim()
    const unavailable = (message: string): ProjectGroupError => ({ type: 'group-unavailable', chatId, message })
    if (!chatId) return err(unavailable('没有指明要并进哪个群'))
    const owner = await ownerFor(subject, unavailable)
    if (!owner.success) return owner
    const { accessToken, userId } = owner.data
    const { projectId } = subject
    const groupProjectId = groupProjectIdFor(projectId, env())
    const chat = makeChatClient(accessToken)
    return cloudFailedOr(async () => {
      // 后台那两发(铸身份、重开时的群核对)落地时会回写名册里的群:先等它们,省得晚到的回写把这里改的群改回去。
      // 锁外先等一遍(它们可能在重试,别占着锁);锁内再等一遍 —— 锁内不会有新的起来(它们只在供给锁里被登记)。
      await settleSessionpageAgentBackgroundWork(
        projectAgents(await listAgents(env(), { includeGuests: true }), subject, userId).map((agent) => agent.gugu_user_id),
      )
      return await withSessionpageProvisionLock(`project-group bind ${projectId} → ${chatId}`, async () => {
        await settleSessionpageAgentBackgroundWork(
          projectAgents(await listAgents(env(), { includeGuests: true }), subject, userId).map((agent) => agent.gugu_user_id),
        )
        const roster = await listAgents(env(), { includeGuests: true })
        const agents = projectAgents(roster, subject, userId)
        const recorded = await readProjectGroupId(projectId, userId, env())
        const previous = recorded || findGroupIdForProject(roster, projectId, userId) || ''
        if (expectedChatId !== undefined && (previous || null) !== expectedChatId && previous !== chatId) {
          return err(unavailable('项目的设备关联已更改，不能用旧的撤销操作覆盖。请重新读取项目。'))
        }

        let state: GroupState = await readGroupState(chat, chatId, userId)
        if (state === 'archived') return err(unavailable('那个群已经归档了'))
        if (state === 'not-a-group') return err(unavailable('那不是一个群'))
        if (state === 'not-member') return err(unavailable('当前账号不在那个群里'))
        // 原来的群留作历史 —— 只报一个真有的群:预留了却从没建出来的那个 id 云端没有,❌ 让界面说「原来的群还在」。
        const previousChatId = previous && previous !== chatId && (await readGroupState(chat, previous, userId)) !== 'missing'
          ? previous
          : null

        // 公网身份已落地的 agent 现在就进群;还没落地的(pending / failed)云端还没有这个人,进不了群 ——
        // 名册里给它钉上这个群,它的身份那一发落地时就带着这个群进来(provision_taskpage_agent 收的就是钉着的群)。
        const landed = agents.filter((agent) => sessionpageCloudIdentityState(agent) === 'ready')
        const joined = new Set<string>()
        if (state === 'missing') {
          // 老版本预留、云端还没建出来的群(另一台机器上那个项目还没开过会话):现在建出来,再和已有的群一样加人。
          state = await createOwnerOnlyGroup(chat, chatId, projectGroupDisplayName(subject.projectName, projectId), userId)
          if (state !== 'active') return err(unavailable('这个群当前账号看不见'))
        }
        let pendingApproval = 0
        if (state === 'active') {
          for (const agent of landed) {
            // 项目里的 agent 都是任务 agent:补进项目群也坐任务座位(不发入群提示)。
            const data = await createGroupAdmin(chat, userId).addAgent(chatId, agent.gugu_user_id, { asTask: true })
              .catch((error: Error) => { throw new ProjectGroupCloudError(error.message) })
            // 群开了「Agent 加入需审批」、而当前账号不是管理员 ⇒ 进了待审,这次不算进群;名册照旧钉着原来的群。
            if (data.status === 'pending_approval') {
              pendingApproval++
              continue
            }
            joined.add(agent.gugu_user_id)
          }
        }

        await rememberProjectGroupId(projectId, chatId, userId, env())
        let movedAgents = 0
        for (const agent of agents) {
          const landedHere = sessionpageCloudIdentityState(agent) === 'ready'
          if (landedHere && !joined.has(agent.gugu_user_id)) continue
          const pinned = cacheString(agent.cache, GROUP_CACHE_KEY)
          const pinnedProject = cacheString(agent.cache, PROJECT_CACHE_KEY)
          if (pinned === chatId && pinnedProject === groupProjectId) continue
          const cache: Record<string, unknown> = {
            ...(agent.cache ?? {}),
            [GROUP_CACHE_KEY]: chatId,
            [PROJECT_CACHE_KEY]: groupProjectId,
          }
          if (pinned !== chatId) cache[GROUP_BEFORE_BIND_CACHE_KEY] = pinned
          await updateAgent({ guguUserId: agent.gugu_user_id }, { cache }, env())
          movedAgents++
        }
        log.info(
          { projectId, chatId, previousChatId: previous || null, agents: agents.length, movedAgents, pendingApproval, groupState: state },
          '#7341 project bound to group — its agents now belong to that group; the previous group is kept as history',
        )
        return ok({
          movedAgents,
          // 原来就绑在这个群上 = 没有被替换掉的群。
          previousChatId,
          changed: recorded !== chatId || movedAgents > 0,
        })
      })
    })
  }

  async function unbind(subject: ProjectGroupSubject): Promise<Result<{ changed: boolean; expectedChatId: string | null }, ProjectGroupError>> {
    const auth = await deps.getAuth()
    if (!auth?.userId) return err(notSignedIn())
    const userId = auth.userId
    const { projectId } = subject
    return withSessionpageProvisionLock(`project-group unbind ${projectId}`, async () => {
      const recorded = await readProjectGroupId(projectId, userId, env())
      const roster = await listAgents(env(), { includeGuests: true })
      const bound = recorded || findGroupIdForProject(roster, projectId, userId) || ''
      if (!bound) return ok({ changed: false, expectedChatId: null })
      let reverted = 0
      for (const agent of projectAgents(roster, subject, userId)) {
        const before = agent.cache?.[GROUP_BEFORE_BIND_CACHE_KEY]
        if (cacheString(agent.cache, GROUP_CACHE_KEY) !== bound) continue
        // The original device may have created the shared group, so it has no "before bind"
        // cache. Clear that pin too; otherwise roster fallback immediately relinks this device.
        const cache: Record<string, unknown> = { ...(agent.cache ?? {}), [GROUP_CACHE_KEY]: typeof before === 'string' ? before : '' }
        delete cache[GROUP_BEFORE_BIND_CACHE_KEY]
        await updateAgent({ guguUserId: agent.gugu_user_id }, { cache }, env())
        reverted++
      }
      await forgetProjectGroupId(projectId, userId, env())
      log.info({ projectId, chatId: bound || null, reverted }, '#7341 project unbound from its group — agents already in it stay')
      // Capture the undo checkpoint under this same lock. Reading it later could mistake a
      // concurrent new binding for the state produced by this unlink and let an old undo overwrite it.
      const expectedChatId = findGroupIdForProject(await listAgents(env(), { includeGuests: true }), projectId, userId) || null
      return ok({ changed: Boolean(recorded) || reverted > 0, expectedChatId })
    })
  }

  return { listBindings, ensureGroup, bindToGroup, unbind }
}
