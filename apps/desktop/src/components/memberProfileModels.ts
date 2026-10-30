import type { AgentDisplayStatus, GroupAgentItem, GroupCollabSnapshot, GroupMemberItem, GroupMemberRole } from '@gugu/core/shared/types/chat'
import type { DisplayIdentity } from '../lib/displayIdentity'
import { identityDisplayName } from '../lib/displayIdentity'
import type { MemberProfileCardModel } from './MemberProfileCard'

export type MemberProfileSide = 'left' | 'right'

// @@@5856 openedFrom:这张卡是从哪一栏点开的。卡片上的动作会落到**某一个输入框**上
// (悄悄话就是),而同一扇窗里现在有两个输入框 —— 不记来源,从话题分栏点开的卡片会把悄悄话
// 挂到主线的输入框上,发出去落在源群里,正是话题要隔开的那个方向。
// anchor = 打开它的那个元素(头像/成员行)。❌ 拍下 getBoundingClientRect 当锚点:列表一滚卡片就留在原地(owner 2a)。
export type ActiveMemberProfile = { member: MemberProfileCardModel; anchor: Element; preferredSide?: MemberProfileSide; openedFrom?: 'main' | 'aside' }

export function agentOwnerDisplayName(
  identity: DisplayIdentity,
  identities: Readonly<Record<string, DisplayIdentity>>,
): string | null {
  if (identity.type !== 'agent' || !identity.owner_user_id) return null
  return identities[identity.owner_user_id]?.display_name ?? null
}

export function toIdentityProfile(identity: DisplayIdentity, role: GroupMemberRole = 'member', scope: 'direct' | 'group' = 'direct', agent?: GroupAgentItem, status?: AgentDisplayStatus, ownerDisplayName?: string | null): MemberProfileCardModel {
  return {
    id: identity.id,
    guguNumber: identity.gugu_number,
    displayName: identity.display_name,
    avatar: identity.avatar,
    bio: identity.bio,
    email: null,
    type: identity.type,
    ownerUserId: identity.type === 'agent' ? identity.owner_user_id : undefined,
    ownerDisplayName: identity.type === 'agent' ? ownerDisplayName ?? null : undefined,
    role,
    profileScope: scope,
    agentStatus: identity.type === 'agent' ? status : undefined,
    listenMode: agent?.listen_mode,
    agentMeta: agent ? { currentTaskTitle: agent.current_task_title, lastAction: agent.last_action } : undefined,
  }
}

export function toHumanProfile(member: GroupMemberItem, identity: DisplayIdentity): MemberProfileCardModel { return toIdentityProfile(identity, member.role, 'group') }

export function toAgentProfile(agent: GroupAgentItem, identity: DisplayIdentity, status?: AgentDisplayStatus, ownerDisplayName?: string | null): MemberProfileCardModel { return toIdentityProfile(identity, agent.role, 'group', agent, status, ownerDisplayName) }

/**
 * 名册成员的资料 + 「发过消息但已不在名册」的人(退群 / 被移出)的资料。后者的身份由消息窗口写入时提交
 * (chatMessageWindowPublication),这里只要 identitiesById 里有就出资料,标 membership: 'former' —— 成员列表
 * 靠这个标记不列他,消息气泡和资料卡照常(#5610 §2.3)。
 */
export function buildMemberProfileMap(
  snapshot: GroupCollabSnapshot,
  identities: Readonly<Record<string, DisplayIdentity>>,
  agentStatuses: Record<string, AgentDisplayStatus> = {},
  senderIds: Iterable<string | null | undefined> = [],
): Record<string, MemberProfileCardModel> {
  const profiles: Record<string, MemberProfileCardModel> = {}
  for (const member of snapshot.humans) if (identities[member.id]) profiles[member.id] = toHumanProfile(member, identities[member.id])
  for (const agent of snapshot.agents) if (identities[agent.id]) profiles[agent.id] = toAgentProfile(agent, identities[agent.id], agentStatuses[agent.id], agentOwnerDisplayName(identities[agent.id], identities))
  for (const id of senderIds) if (id && !profiles[id] && identities[id]) profiles[id] = { ...toIdentityProfile(identities[id], 'member', 'group', undefined, undefined, agentOwnerDisplayName(identities[id], identities)), membership: 'former' }
  const members = Object.keys(profiles).map((id) => identities[id])
  for (const id of Object.keys(profiles)) profiles[id].displayName = identityDisplayName(identities[id], members)
  return profiles
}
