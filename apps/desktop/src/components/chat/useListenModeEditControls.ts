import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ListenMode } from '@gugu/core/shared/types/chat'
import { chatService } from '../../lib/chat'
import { rendererLogger } from '../../lib/log'
import type { MemberProfileCardModel, MemberProfileEditControls } from '../MemberProfileCard'

const listenLog = rendererLogger('chat/listen-mode')

/**
 * @@@1241 — listen-mode edit wiring for the member-profile popovers users actually open
 * (message-area avatar + right-rail + 成员行上的档位钮).
 *
 * 谁能改:这个 agent 的主人,❌ 群主 / 管理员(owner 10-17:每个人调自己的 agent,管理员不管别人的)。
 * 库里同一条规则(members_update_own + guard_member_listen_mode_change),这里只决定画不画成能点。
 *
 * Scope is intentionally listen-only: role/remove editing is NOT surfaced from these
 * message-area / right-rail popovers. The full admin form (群角色/移出) lives in the group member
 * panel (GroupMemberPanelControls) — passing only onChangeListenMode keeps showEdits false in
 * MemberProfileCard, so no duplicated inline admin form (#1241 Part B, #1248).
 */
export function useListenModeEditControls(opts: {
  chatId: string | null
  currentUserId: string | null
  onReload: () => Promise<void> | void
}): (profile: MemberProfileCardModel) => MemberProfileEditControls | undefined {
  const { chatId, currentUserId, onReload } = opts
  const { t } = useTranslation('messaging')
  const [busy, setBusy] = useState(false)
  // 上一次没改成,记在「这个群里的这个 agent」名下:只在它的卡 / 行上显示,下一次点击先清掉。
  // 要带上群:消息区头像卡那份 hook 跨群不重挂,只记 agent 会把 A 群的失败挂到 B 群同一个 agent 上。
  // 界面只写一句对任何失败都成立的话,原始报错进日志。
  const [failed, setFailed] = useState<{ chatId: string; agentId: string } | null>(null)

  const runMutation = useCallback(async (target: { chatId: string; agentId: string }, action: () => Promise<void>) => {
    setBusy(true)
    setFailed(null)
    try {
      await action()
      // Reload so the segment reflects persisted state; on failure the segment honestly keeps the old value.
      await onReload()
    } catch (error) {
      listenLog.error({ error, ...target }, 'set listen mode failed')
      setFailed(target)
    } finally {
      setBusy(false)
    }
  }, [onReload])

  return useCallback((profile: MemberProfileCardModel): MemberProfileEditControls | undefined => {
    // 只有主人看自己的 agent 时档位能点;其余人看到的是只读镜像(editControls 不给)。
    if (!chatId || !currentUserId || profile.type !== 'agent' || profile.ownerUserId !== currentUserId) return undefined
    return {
      onChangeListenMode: (mode: ListenMode) =>
        runMutation({ chatId, agentId: profile.id }, () => chatService.setAgentListenMode(chatId, profile.id, mode)),
      busy,
      editError: failed?.chatId === chatId && failed.agentId === profile.id ? t('chatService.errors.setListenModeFailed') : null,
    }
  }, [busy, chatId, currentUserId, failed, runMutation, t])
}
