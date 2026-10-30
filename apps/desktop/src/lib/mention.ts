// Mention parsing shared between the composer picker and the send path.
//
// @@@1703 — a PASSIVE agent @mentioned by TYPING "@Name " inline (not selecting the picker) must still
// hard-trigger. The picker fills mentionTargets via acceptMention (click / Enter-Tab in the popup), but a
// typed mention with a trailing space closes the popup WITHOUT selecting → mentionTargets stays empty →
// to_user_ids=null → the DB non-@ branch drops passive members (listen_mode = active) → silence.
// Fix: at send time, ALSO scan the final text for any group member's @token and union those ids into
// to_user_ids — so a typed @mention routes identically to a picked one.

import type { GroupCollabSnapshot } from '@gugu/core/shared/types/chat'
import { findMentionSpans } from '@gugu/core/shared/mentionToken.mjs'
import { markdownMentionReferences } from '@gugu/session-shared/markdown/dialect'
import { i18n } from '@/i18n'
import { identityDisplayName } from './displayIdentity'

export interface MentionCandidate {
  id: string
  name: string
  type: 'all' | 'human' | 'agent'
  avatar?: string | null
  ownerDisplayName?: string
  /** 只用于 @ 候选搜索(lib/mentionMatch):咕咕号与 owner 给的备注。插入与投递仍用 name。 */
  guguNumber?: number | null
  alias?: string | null
  harness?: string | null
  session_archived_at?: string | null
}

export type GroupRosterCandidate = MentionCandidate & { type: 'human' | 'agent' }

type RosterIdentity = { display_name: string; name_serial?: number | null; avatar?: string | null; owner_user_id?: string | null; gugu_number?: number | null; session_archived_at?: string | null; agent_type?: string | null }

// 名册条目的附加字段:agent 的主人名(候选里显示「· 某某的」)与咕咕号(候选搜索用)。
function rosterExtras(type: MentionCandidate['type'], identity: RosterIdentity, identities: Readonly<Record<string, RosterIdentity>>) {
  const ownerDisplayName = type === 'agent' && identity.owner_user_id
    ? identities[identity.owner_user_id]?.display_name
    : undefined
  const guguNumber = { avatar: identity.avatar, ...(identity.agent_type ? { harness: identity.agent_type } : {}), ...(identity.gugu_number != null ? { guguNumber: identity.gugu_number } : {}),
    ...(type === 'agent' && identity.session_archived_at != null ? { session_archived_at: identity.session_archived_at } : {}) }
  return ownerDisplayName?.trim() ? { ownerDisplayName, ...guguNumber } : guguNumber
}

/** Project the subscribed group snapshot into the closed roster shared by the picker and name-call index. */
export function buildGroupRosterCandidates(
  snapshot: Pick<GroupCollabSnapshot, 'humans' | 'agents'>,
  identities: Readonly<Record<string, RosterIdentity>>,
): GroupRosterCandidate[] {
  // 名册 = 「可以按名字点名的人」。身份没解析出来的成员没有名字,就不在这个集合里 —— 这不是容错,是定义。
  // 从前这里用 `?? ''` 冒充名字,而空名字会让提及判据的正则退化成「匹配任何裸 @」:一条
  // 「约 @ 3点」就把消息静默投给了这个成员,是 agent 的话还会白跑一轮任务。#1624 已写明解析失败绝不用
  // 占位值冒充,而这里的值比显示更严重 —— 它是投递依据。身份的来源见 replaceGroupRoster(名册与身份同事务发布)。
  const members = [...snapshot.humans, ...snapshot.agents.filter((agent) => agent.account_status !== 'removed')]
  const named = members.flatMap((member) => identities[member.id] ? [{ id: member.id, ...identities[member.id] }] : [])
  return members.flatMap((member) => {
    const identity = identities[member.id]
    const name = identity && identityDisplayName({ id: member.id, ...identity }, named)
    const harness = snapshot.agents.find((agent) => agent.id === member.id)?.client
    return name && name.trim() !== '' ? [{ id: member.id, name, type: member.type, ...rosterExtras(member.type, identities[member.id], identities),
      ...(harness ? { harness } : {}) }] : []
  })
}

/**
 * @@@5856 话题分栏里,能点名的人 = 话题现有成员 ∪ **来源线**的成员。
 *
 * 为什么要并进来:spec「参与靠在里面说话,或被 @ 进来」,而服务端的 is_addressable_in 本来就放行
 * 来源线的成员(被点的那一刻由触发器拉进来)。客户端只拿话题自己的名册当候选,就比服务端**更严** ——
 * 后果是 spec 指定「那时才有成员列表」的那个视图里,恰恰一个人都拉不进来:名单外的 @ 不进
 * to_user_ids,于是「看得见但没唤醒」。
 *
 * 来源线的成员从会话列表那一行的 member_user_ids 取(本地已有,零额外往返);身份解析不出来的
 * 不进集合 —— 与 buildGroupRosterCandidates 同一条定义:没有名字就不能按名字点名。
 */
export function withSourceLineCandidates(
  topicCandidates: GroupRosterCandidate[],
  sourceMemberUserIds: readonly string[] | null | undefined,
  identities: Readonly<Record<string, RosterIdentity & { type: 'human' | 'agent' }>>,
): GroupRosterCandidate[] {
  if (!sourceMemberUserIds?.length) return topicCandidates
  const seen = new Set(topicCandidates.map((candidate) => candidate.id))
  const extra = sourceMemberUserIds.flatMap((id) => {
    if (seen.has(id)) return []
    const identity = identities[id]
    const name = identity?.display_name
    return name && name.trim() !== '' ? [{ id, name, type: identity.type, ...rosterExtras(identity.type, identity, identities) }] : []
  })
  const combined = [...topicCandidates, ...extra]
  const named = combined.flatMap((member) => identities[member.id] ? [{ id: member.id, ...identities[member.id] }] : [])
  return combined.map((member) => identities[member.id]
    ? { ...member, name: identityDisplayName({ id: member.id, ...identities[member.id] }, named, member.alias) }
    : member)
}

/** Sentinel user id the DB @-branch treats as "@all" (broadcast). */
export const MENTION_ALL_USER_ID = '*'

/** 输入框里点选的人还算不算:名字在正文里仍是一处提及,和发送路由同一个读法(名册上取最长,「@Claude 2」不算 Claude)。 */
export function activeMentionPicks<T extends { displayName: string; userId?: string }>(text: string, picks: T[], members: MentionCandidate[]): T[] {
  const { references, plain } = mentionParts(text)
  const addressed = new Set(references.filter((ref) => ref.target.startsWith('aid:')).map((ref) => ref.target.slice(4)))
  const typed = new Set(findMentionSpans(plain, [...members.map((m) => m.name), ...picks.map((pick) => pick.displayName)]).map((span) => span.name))
  return picks.filter((pick) => (pick.userId && addressed.has(pick.userId)) || typed.has(pick.displayName))
}

function mentionParts(text: string) {
  const references = markdownMentionReferences(text)
  let plain = text
  for (const ref of [...references].reverse()) plain = plain.slice(0, ref.start) + ' '.repeat(ref.end - ref.start) + plain.slice(ref.end)
  return { references, plain }
}

/**
 * Resolve the final `to_user_ids` for a send, unioning:
 *  1. ids the user selected via the picker (acceptMention), and
 *  2. ids of any group member whose @token appears in the typed text (covers typing "@Name " without picking).
 * A name explicitly selected in the picker uses only its selected ids; same-named members must not be added.
 *
 * Non-group chats have no @mention routing → returns the picker ids unchanged.
 * '@all' resolves to the {@link MENTION_ALL_USER_ID} sentinel, matching the picker's own mapping.
 */
export function resolveMentionUserIds(
  text: string,
  pickerUserIds: string[],
  members: MentionCandidate[],
  isGroupChat: boolean,
): string[] {
  const ids = new Set(pickerUserIds)
  if (isGroupChat) {
    const { references, plain } = mentionParts(text)
    const memberIds = new Set(members.map((member) => member.id))
    for (const ref of references) {
      if (ref.target.startsWith('aid:') && memberIds.has(ref.target.slice(4))) ids.add(ref.target.slice(4))
    }
    const selectedNames = new Set(members
      .filter((member) => ids.has(member.type === 'all' ? MENTION_ALL_USER_ID : member.id))
      .map((member) => member.name))
    const typedNames = new Set(findMentionSpans(plain, members.map((m) => m.name)).map((span) => span.name))
    for (const m of members) {
      if (selectedNames.has(m.name)) continue
      if (typedNames.has(m.name)) ids.add(m.type === 'all' ? MENTION_ALL_USER_ID : m.id)
    }
  }
  return [...ids]
}

// @@@2017 owner 终版 + product spec §3 —— @all 正文 token 是 `@所有人`(镜像 ChatMessageComposer 候选名),兜底徽标「全员」。
// 「寻址的表达」单重显示的完整实现(注入 nonce marker + 注入后再解析定高亮/兜底)见 mentionRenderModel.buildMentionRender。
export function mentionAllName(): string { return i18n.t('composer.mentionAll', { ns: 'messaging' }) }
export function mentionAllBadge(): string { return i18n.t('composer.memberType.all', { ns: 'messaging' }) }

// #1641 的开头呼语热路径在 shared/rosterNameMatching.mjs；这里仍只负责结构化 @ 与名册投影。
