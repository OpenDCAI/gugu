import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { GroupCollabSnapshot } from '@gugu/core/shared/types/chat'
import { chatService } from '../lib/chat'
import type { MemberProfileCardModel, MemberProfileEditControls } from '../components/MemberProfileCard'
import type { ActiveMemberProfile } from '../components/memberProfileModels'
import { useListenModeEditControls } from '../components/chat/useListenModeEditControls'
import { groupRoleRevision, useGroupChatSettings } from '../components/chat/useGroupChatSettings'
import { EMPTY_GROUP_COLLAB } from './useGroupCollabLoader'

/**
 * 从话题分栏点开的成员名片,倾听模式要读写**话题自己**那行 chat_members,❌ 不是来源群的。
 *
 * 分栏复用主线那张名片(ChatAreaPanel 的 MemberProfilePopover):名片的 member 取自群名册
 * (buildMemberProfileMap),改档走 setAgentListenMode(群 id)。于是用户在话题里看到的是群的档位,
 * 点一下改掉的也是群的 —— 2026-09-24 设计同事 截图:「主被动居然是群的而不是 topic 的」。
 * 话题的档位是它自己的一套(product spec「成员与响应档位」,数量线也是按线算的),
 * 分栏 👥 里的 MemberListPanel 本来就按话题 chatId 读写,名片要跟它说同一个数。
 *
 * 做法:分栏开着就预读一次话题名册(权威 getGroupCollab(topicId)),名片每次打开再重读一次;
 * 从分栏打开的名片用话题名册里的 listen_mode / role 覆盖,编辑控件用同一个
 * useListenModeEditControls 但 chatId = 话题,管理能力来自该话题的服务端来源群投影。
 * 名册还没到、或这个 agent 不在话题名册里(看得见但不是参与者)⇒ 名片退成单人卡,不画档位
 * —— ❌ 不拿群的档位顶上(那正是这个 bug),也❌ 不画一个默认「主动」冒充读数。
 */
export function useTopicScopedMemberProfile(opts: {
  profile: ActiveMemberProfile | null
  topicChatId: string | null
  authorityRevision?: number
  currentUserId: string | null
  groupEditControlsFor: (profile: MemberProfileCardModel) => MemberProfileEditControls | undefined
}): { profile: ActiveMemberProfile; editControls: MemberProfileEditControls | undefined } | null {
  const { profile, topicChatId, currentUserId, groupEditControlsFor, authorityRevision = 0 } = opts
  const [roster, setRoster] = useState<{ chatId: string; snapshot: GroupCollabSnapshot } | null>(null)

  const loadSeqRef = useRef(0)
  const load = useCallback(async () => {
    const seq = ++loadSeqRef.current
    if (!topicChatId) { setRoster(null); return }
    try {
      const { snapshot } = await chatService.getGroupCollab(topicChatId)
      if (seq === loadSeqRef.current) setRoster({ chatId: topicChatId, snapshot })
    } catch {
      // 不是参与者(GroupCollabEmptyError)或读失败:话题名册就是空的 ⇒ 名片不画档位(见上)。
      if (seq === loadSeqRef.current) setRoster({ chatId: topicChatId, snapshot: EMPTY_GROUP_COLLAB })
    }
  }, [topicChatId])

  const fromTopic = profile?.openedFrom === 'aside' && !!topicChatId
  const openedMemberId = fromTopic ? profile?.member.id : undefined
  useEffect(() => { void load() }, [load, openedMemberId])

  const topicSnapshot = roster && roster.chatId === topicChatId ? roster.snapshot : null
  const { settings, reload } = useGroupChatSettings(topicChatId, topicSnapshot ? groupRoleRevision(topicSnapshot) : undefined, authorityRevision)
  const topicEditControlsFor = useListenModeEditControls({
    chatId: topicChatId,
    currentUserId,
    settings,
    onAuthorityReload: reload,
    onReload: load,
  })

  return useMemo(() => {
    if (!profile) return null
    if (!fromTopic) return { profile, editControls: groupEditControlsFor(profile.member) }
    const agent = topicSnapshot?.agents.find((a) => a.id === profile.member.id)
    const human = topicSnapshot?.humans.find((h) => h.id === profile.member.id)
    const member: MemberProfileCardModel = agent
      ? { ...profile.member, profileScope: 'group', role: agent.role, listenMode: agent.listen_mode }
      : human
        ? { ...profile.member, profileScope: 'group', role: human.role, listenMode: undefined }
        : { ...profile.member, profileScope: 'direct', listenMode: undefined }
    return { profile: { ...profile, member }, editControls: agent ? topicEditControlsFor(member) : undefined }
  }, [fromTopic, groupEditControlsFor, profile, topicEditControlsFor, topicSnapshot])
}
