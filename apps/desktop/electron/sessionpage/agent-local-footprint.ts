// @@@4526 AGENT 的本机足迹 —— 一个 agent 停止存在时,这台机器上要跟着消失的东西。
//
// 一个 agent 有两半:云端身份(identity.users,归 agent-identity)与**本机足迹**——花名册记录、runtime
// session/activity 文件、投递注册、以及会话页会话到它的绑定。云端那半有两条删除驱动:
//
//   · 会话页那边没了这条会话 ⇒ [[cascade-reap]] 的 diff 收回它;
//   · owner 自己在通讯录/设置里按了删除 ⇒ 渲染层直接调 `remove_owned_agent`。
//
// 本机这半在此之前**只有第一条驱动**。第二条压根没有本机侧的对应动作 —— 不是漏了一步,是整条路
// 不存在。于是 owner 删完之后花名册仍留着它,而 provisioning 的幂等键就是花名册里那条 conversation
// 绑定:下一次切回会话页,它按"这条会话还没供给过"重新开户,那个被删掉的联系人就带着 Online 回来了。
//
// 所以本模块把「本机足迹的释放」抽成**一个**动作,给两条驱动共用。❌ 不为 owner 删除单开一套并行清理:
// 两条驱动释放的是同一批东西,分两份实现只会让下一次改动只改到其中一份。
//
// 顺序沿用 cascade-reap 已经写死的那条(它的理由在这里同样成立):
//   ① 先摘投递注册 —— 不能让投递打进一个正要被抹掉的绑定;
//   ② 再删 runtime session 文件;
//   ③ 最后才删花名册记录 —— 它本身就是"这个绑定还看得见"的东西,留到最后让失败的一轮可重试;
//   ④ 花名册确实摘掉之后才立碑。
//
// ⚠️ 本模块只**释放足迹**:不终止 provider 进程,不 dispose 运行时会话,也不取消在飞的回合。
// 「owner 删除 ⇒ 先取消那一轮」是删除**驱动**的语义(它才是"停下它"的意思),所以那一步在调用方
// (owner-delete 的 IPC)按顺序做,而不是塞进这个两条驱动共用的函数里 —— 会话页那条驱动的会话
// 本来就没了,它要的是 dispose/teardown,不是 cancel。两条驱动语义不同的那一段就不该共用。
import {
  listAgents,
  recordReapedAgents,
  removeAgentRuntimeSession,
  removeAgents,
} from '@gugu/core'
import {
  SESSION_CACHE_KEY,
  OWNER_CACHE_KEY,
  PARKED_SESSION_CACHE_KEY,
  cacheString,
} from './emdash-agent-provisioning'
import { emdashAgentRegistry } from './emdash-agent-registry'
import { unregisterLocalSessionDeliveryForAgent } from './local-session-delivery'

/**
 * @@@4526B 这个 agent 绑定的会话页会话 id(没有绑定 → '')。取消在飞回合要先知道取消**哪条会话**,
 * 而这层「agent → conversation」绑定就存在花名册记录的 cache 里 —— 与本模块读的是同一处,
 * ❌ 不在调用方再抄一遍 roster 读法。
 */
export async function sessionpageSessionIdForAgent(
  agentUserId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  if (!agentUserId) return ''
  const roster = await listAgents(env, { includeGuests: true })
  const record = roster.find((agent) => agent.gugu_user_id === agentUserId)
  return cacheString(record?.cache, SESSION_CACHE_KEY)
}

export interface ReleaseAgentLocalFootprintInput {
  agentUserId: string
  /** 墓碑上的展示名。留空时从花名册记录取——删除提示要说得出「谁」被删了。 */
  name?: string
  /**
   * 云端身份是否**确认**已删。only-true 才立碑、才摘 local-session 投递目标:
   * not-homed(身份在别的设备上活着)不是删除,本机记录照摘,但它并没有永久不可达。
   */
  identityRemoved: boolean
  /**
   * 墓碑要不要按**会话**记账(默认要)。按会话记账的意思是「这条会话此后不再有身份」—— 那是 owner 在通讯录
   * 亲手删 agent 时要的(#4526:会话照跑,但别把他删掉的联系人再造回来)。
   * #4277 回收器因「会话归档 / 删除」收 agent 时**不能**这样记:归档的会话再打开、或取消归档,按 spec 该
   * 重新开户(「驱动过的会话在就在」);按会话记了碑就永远开不了,真机:归档的「何丽丽」换号后报「还没有
   * 咕咕身份」。回收器传 false ⇒ 碑只记 agent id(指名投递照旧报「已删除」),会话可再开户。
   */
  tombstoneSession?: boolean
  env?: NodeJS.ProcessEnv
}

export interface ReleasedAgentLocalFootprint {
  /** 本轮真的摘掉了花名册记录吗(false = 本来就没有,幂等重放)。 */
  rosterRemoved: boolean
  /** 该 agent 绑定的会话页会话 id;没有绑定时为 ''。 */
  sessionId: string
  name: string
}

/**
 * 释放一个已被删除的 agent 在这台机器上的全部足迹。幂等:重复调用收敛到同一终态,不制造第二份真相。
 *
 * Fail-loud:任何一步抛出都原样上抛。本机足迹没释放干净却回报成功,正是这张票里
 * 「UI 说 Agent deleted、东西还在」的那个形状。
 */
export async function releaseAgentLocalFootprint(
  input: ReleaseAgentLocalFootprintInput,
): Promise<ReleasedAgentLocalFootprint> {
  const env = input.env ?? process.env
  const agentUserId = input.agentUserId?.trim()
  if (!agentUserId) throw new Error('releaseAgentLocalFootprint requires an agentUserId')

  // 会话绑定要在摘记录**之前**读出来:记录一删,这条绑定就再也查不到了,而墓碑要靠它拒绝重新开户。
  const roster = await listAgents(env, { includeGuests: true })
  const record = roster.find((agent) => agent.gugu_user_id === agentUserId)
  // #4277 停放行的绑定在 parked 格;它的墓碑同样要按会话记账,否则那个账号回来会重新开户。
  const sessionId = cacheString(record?.cache, SESSION_CACHE_KEY)
    || cacheString(record?.cache, PARKED_SESSION_CACHE_KEY)
  const ownerUserId = cacheString(record?.cache, OWNER_CACHE_KEY)
  const name = input.name?.trim() || record?.name || ''

  // ① 停止路由。registry 是进程内的投递地图,先摘它,后面的删文件/删记录才不会与一次在飞的投递交错。
  emdashAgentRegistry.unregister(agentUserId)

  // ② runtime session —— 本机运行态文件。纯机器状态,没有用户内容,直接删。
  await removeAgentRuntimeSession(agentUserId, env)

  // ③ 花名册记录。它是"这台机器上还有这个 agent"的开关,也是 provisioning 的幂等键。
  const removed = await removeAgents((agent) => agent.gugu_user_id === agentUserId, env)

  // ④ 云端身份确认删除 + 花名册已摘 = 永久不可达 ⇒ 立碑。碑同时按 conversation id 记账,
  //    让那条仍然活着的会话页会话此后按 identity-none 处理,而不是被重新开户。
  if (input.identityRemoved) {
    await recordReapedAgents(
      [{
        gugu_user_id: agentUserId,
        name,
        reaped_at: new Date().toISOString(),
        ...(sessionId && input.tombstoneSession !== false ? { conversation_id: sessionId } : {}),
        ...(ownerUserId ? { owner_user_id: ownerUserId } : {}),
      }],
      env,
    )
    unregisterLocalSessionDeliveryForAgent(agentUserId, sessionId || undefined)
  }

  return { rosterRemoved: removed.length > 0, sessionId, name }
}
