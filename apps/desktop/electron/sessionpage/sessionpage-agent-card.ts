// @@@sessionpage TASKPAGE-FUSION — 「分享这个 agent 的名片」所需的最小解析:会话页的**一条会话** → 它绑定的
// gugu agent(spec ⑨ 的 provisioning 产物)。分享 UI 本身**不**在这里、也不在会话页后端里重造:gugu 渲染层
// 已有 SharePosterDialog(+ contact QR),由它打开;这里只回答「当前这条会话是哪个 agent」。
//
// 只回 agentUserId + 名字:咕咕号与头像渲染层已经有(通讯录里就是自有 agent 的那几行)。名字由调用方从
// `identity.users.display_name` 读回 —— 与通讯录/群成员看到的同一个「Codex N」(spec ⑨:这个可读名就是
// 寻址名),所以按钮上显示什么、名片上分享的就是什么,不会两处不一致。roster 这里只提供绑定 id。
//
// 键是 **conversationId**:每条会话各有一个 agent。会话页头部拿得到聊天栏当前这条会话的 id
// (session-pane-policy 的 activeChatSessionId)。
import type { SessionShellAgentCard } from '../../src/session/shared/lib/ipc/shell-port'
import { localAgentForSession } from './sessionpage-session-agent'

// 线上形状与会话页壳口共用同一份定义(#5012),❌ 两边各抄一份再漂移。
export type SessionpageAgentCard = SessionShellAgentCard

export type SessionpageCanonicalIdentityReader = (
  agentUserIds: readonly string[],
) => Promise<readonly { id: string; display_name: string }[]>

async function canonicalNameFor(
  agentUserId: string,
  readCanonicalIdentities: SessionpageCanonicalIdentityReader,
): Promise<string | null> {
  const identity = (await readCanonicalIdentities([agentUserId])).find((row) => row.id === agentUserId)
  const displayName = identity?.display_name.trim()
  return displayName || null
}

/**
 * 解析某条会话页会话绑定的 gugu agent。
 *
 * 返回 null = 这条会话没有 agent 身份(非会话页 provider、还没 provision 完、或已被 cascade-reap 收走)→
 * 调用方据此把分享入口置灰,而不是渲染一个点了没反应的按钮(❌ fake)。
 */
export async function resolveSessionpageAgentCard(
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
  ownerUserId: string | null,
  readCanonicalIdentities: SessionpageCanonicalIdentityReader,
): Promise<SessionpageAgentCard | null> {
  const id = sessionId.trim()
  if (!id) return null
  // #4277 传了 owner 就按「当下账号」看:名片是**号**的,不是会话的 —— 同一条会话在 A/B 两个账号下
  // 各有各的号。活动行属于别家账号 ⇒ 对这个账号来说这条会话还没有名片(入口置灰),❌ 把别人的号分享出去。
  const agent = await localAgentForSession(id, env, ownerUserId)
  if (!agent?.gugu_user_id) return null
  const displayName = await canonicalNameFor(agent.gugu_user_id, readCanonicalIdentities)
  return displayName ? { agentUserId: agent.gugu_user_id, displayName } : null
}
