import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { GroupChatSettings, ListenMode } from '@gugu/core/shared/types/chat'
import { chatService } from '../../lib/chat'
import { rendererLogger } from '../../lib/log'
import { canEditAgentListenMode } from '../../lib/groupMemberPermissions'
import type { MemberProfileCardModel, MemberProfileEditControls } from '../MemberProfileCard'

const listenLog = rendererLogger('chat/listen-mode')

/**
 * @@@1241 — listen-mode edit wiring for the member-profile popovers users actually open
 * (message-area avatar + right-rail + 成员行上的档位钮).
 *
 * The agent owner and current source-group managers may edit listen mode.
 * The database enforces the same rule through set_agent_listen_mode_as.
 *
 * Scope is intentionally listen-only: role/remove editing is NOT surfaced from these
 * message-area / right-rail popovers. The full admin form (群角色/移出) lives in the group member
 * panel (GroupMemberPanelControls) — passing only onChangeListenMode keeps showEdits false in
 * MemberProfileCard, so no duplicated inline admin form (#1241 Part B, #1248).
 */
export function useListenModeEditControls(opts: {
  chatId: string | null
  currentUserId: string | null
  settings: Pick<GroupChatSettings, 'my_role' | 'can_manage'> | null
  onReload: () => Promise<void> | void
}): (profile: MemberProfileCardModel) => MemberProfileEditControls | undefined {
  const { chatId, currentUserId, settings, onReload } = opts
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
    if (!chatId || !canEditAgentListenMode(profile, currentUserId, settings)) return undefined
    return {
      onChangeListenMode: (mode: ListenMode) =>
        runMutation({ chatId, agentId: profile.id }, () => chatService.setAgentListenMode(chatId, profile.id, mode)),
      busy,
      editError: failed?.chatId === chatId && failed.agentId === profile.id ? t('chatService.errors.setListenModeFailed') : null,
    }
  }, [busy, chatId, currentUserId, failed, runMutation, settings, t])
}
