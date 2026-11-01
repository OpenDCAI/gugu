// #2115 普通 ACP 回合失败条：composer 上方浮动条同槽位（RunningTokenBar 的失败态邻居，flexShrink:0
// 兄弟，不 overlay 消息列表）。「{name} 回复失败：{人话}」+ 重试 + 关闭——重试 = CAS error→pending
// 重排原 deliver 命令（真重投递，❌ 假按钮）；原始错误只进 console（useAgentTurnFailure 已记）。
// 与聊天流共用 TurnFailureCard；原因仍为既有本地化文案，宿主诊断不进入展示层。

import { useState, type ReactNode } from 'react'
import { X } from '@/lib/icons'
import { turnFailureReasonFromError } from '@gugu/core/shared/turnFailurePresentation'
import { TurnFailureCard } from './chat/TurnFailureCard'
import { type AgentTurnFailure } from '../lib/agentTurnFailure'
import { rendererLogger } from '../lib/log'
import { requeueErroredDeviceCommand } from '../lib/supabase'
import { platform } from '../platform'
import { useAgentTurnFailure } from '../hooks/useAgentTurnFailure'
import { useTranslation } from 'react-i18next'
import { useContactsStore } from '../store/contactsContext'
import { AgentSettingsModal } from './agentsettings/AgentSettingsModal'
import { Button } from './ui/Button'
import { IconButton } from './ui/IconButton'
import { useStoredAgentTurnFailure } from '../hooks/useStoredAgentTurnFailure'
import { agentTurnFailureMuteKind } from '../lib/agentTurnFailureMute'
import { Avatar } from './Avatar'
import type { MemberProfileCardModel } from './MemberProfileCard'

type AgentTurnFailureSlotProps = {
  chatId: string | null
  threadRootId: string | null
  profiles: Record<string, { displayName?: string | null; avatar?: string | null; membership?: MemberProfileCardModel['membership'] } | undefined>
}

// ChatAreaPanel 受 CI god-file 守卫；跨 runtime 的会话状态在这个单一挂载点组合。
// 起任务 / 恢复失败的横幅在说这次失败时,回合失败条不再说一遍(#7103);横幅收掉后失败还在,它照常出现、照常能重投递。
export function AgentConversationNoticeSlot({
  sessionpageNotices,
  failureExplained,
  ...failureProps
}: AgentTurnFailureSlotProps & { sessionpageNotices: ReactNode; failureExplained: boolean }) {
  return (
    <>
      {sessionpageNotices}
      {failureExplained ? null : <AgentTurnFailureSlot {...failureProps} />}
    </>
  )
}

export function AgentTurnFailureSlot({
  chatId,
  threadRootId,
  profiles,
}: AgentTurnFailureSlotProps) {
  const { t } = useTranslation('messaging')
  const local = useAgentTurnFailure(chatId, threadRootId)
  const { contacts } = useContactsStore()
  const stored = useStoredAgentTurnFailure(chatId, threadRootId, contacts.filter((contact) => contact.type === 'agent' && profiles[contact.id] && profiles[contact.id]?.membership !== 'former').map((contact) => contact.id))
  const failure = local.failure ?? stored.failure
  const [modelOpen, setModelOpen] = useState(false)
  const stateKind = failure ? agentTurnFailureMuteKind(failure.rawMessage) : null
  const displayName = failure ? profiles[failure.agentUserId]?.displayName ?? t('agent.fallbackName') : ''
  if (!chatId) return null
  if (!failure) return stored.readFailed ? <div data-chat-composer-notice="" className="mx-3 my-2 flex items-center gap-2 text-[var(--muted-fg)]" role="status"><span>{t('agent.turnFailure.statusReadFailed')}</span><Button variant="ghost" size="sm" onClick={stored.retry}>{t('agent.turnFailure.retry')}</Button></div> : null
  const profile = profiles[failure.agentUserId]
  const contact = contacts.find((entry) => entry.id === failure.agentUserId)
  const dismiss = () => {
    local.dismiss()
    stored.dismiss(failure.commandId)
  }
  return (
    <>
    {stateKind ? (
      <AgentQuotaStatus
        agentId={failure.agentUserId}
        displayName={displayName}
        avatar={profile?.avatar ?? null}
        state={t(`agent.turnFailure.state.${stateKind}`)}
        onOpenModel={contact ? () => setModelOpen(true) : undefined}
        onDismiss={dismiss}
      />
    ) : (
      <AgentTurnFailureBar
        failure={failure}
        displayName={displayName}
        avatar={profile?.avatar ?? null}
        onDismiss={dismiss}
        onOpenModel={contact ? () => setModelOpen(true) : undefined}
      />
    )}
    {modelOpen && contact ? <AgentSettingsModal agent={contact} initialTab="aimodel" onClose={() => setModelOpen(false)} /> : null}
    </>
  )
}

// #7685 额度/模型类失败 = agent 的状态，不是一条通知：和运行条同一排、同一种 token 形状（头像 + 名 + 状态词），
// 不流光；点状态去切模型，关闭沿用同一命令版本的 dismissal。下一次投递成功，它也会自然消失。
export function AgentQuotaStatus({ agentId, displayName, avatar, state, onOpenModel, onDismiss }: {
  agentId: string
  displayName: string
  avatar: string | null
  state: string
  onOpenModel?: () => void
  onDismiss?: () => void
}) {
  const { t } = useTranslation('messaging')
  return (
    <div data-testid="agent-quota-status" className="aqs-bar">
      <style>{QUOTA_STYLE}</style>
      {/* 与 InlineAction 同一做法：ghost Button 去掉控件高与底色，读起来就是运行条里的一个 token。 */}
      <Button
        variant="ghost"
        className="aqs-tok h-auto min-h-0 max-[719px]:min-h-0 border-0 p-0 gap-[7px] font-[inherit] text-[length:inherit] leading-[inherit] text-[var(--faint-fg)] [&:hover:not([data-disabled])]:bg-transparent"
        disabled={!onOpenModel}
        onClick={onOpenModel}
        aria-label={t('agent.turnFailure.stateAction', { name: displayName, state })}
      >
        <Avatar name={displayName} avatarUrl={avatar} seed={agentId} size="xs" isAgent />
        <span className="aqs-nm">{displayName}</span>
        <span className="aqs-state">{state}</span>
      </Button>
      {onDismiss ? <IconButton size="sm" onClick={onDismiss} aria-label={t('common.close')} data-testid="agent-quota-dismiss"><X size={14} aria-hidden /></IconButton> : null}
    </div>
  )
}

// 几何与运行条 `.rtb-bar/.rtb-tok` 一致（同一排、同一刻度）；状态词用 --warn，不流光。
const QUOTA_STYLE = `
.aqs-bar{display:flex;align-items:center;gap:16px;padding:4px 14px 2px 24px;font-size:var(--font-caption);color:var(--faint-fg);white-space:nowrap;flex-shrink:0}
.aqs-tok:not([data-disabled]):hover .aqs-state{text-decoration:underline;text-underline-offset:2px}
.aqs-tok[data-disabled]{opacity:1;cursor:default}
.aqs-nm{color:var(--faint-fg)}
.aqs-state{color:var(--warn);font-weight:500}
`

const turnFailureLog = rendererLogger('agent/turn-failure')

export function AgentTurnFailureBar({
  failure,
  displayName,
  avatar,
  onDismiss,
  onOpenModel,
}: {
  failure: AgentTurnFailure
  /** 由调用方（ChatAreaPanel）从成员档案解析；解析不到时传兜底名。 */
  displayName: string
  avatar: string | null
  onDismiss: () => void
  onOpenModel?: () => void
}) {
  const [retrying, setRetrying] = useState(false)

  const handleRetry = async () => {
    if (retrying) return
    setRetrying(true)
    try {
      const won = await requeueErroredDeviceCommand(failure.commandId)
      if (!won) {
        // 命令已不在 error 态（被别处重排/清理）→ 本条失败条过时，收起即可，不盲改。
        console.warn(`[agent-turn] retry skipped: command ${failure.commandId} is no longer in error state`)
        onDismiss()
        return
      }
      // 重排是一次 UPDATE,库那侧不会为它发 `command_created` 广播(只挂在 INSERT 上)⇒ 由这里告诉本机的设备 runtime
      // 当场去取;不说这一声,这个按钮就要等下一个对账节拍(30 s)才见效 —— 点了没反应的按钮(#5906)。
      try {
        platform.notifyDeviceCommandsChanged?.()
      } catch (notifyErr) {
        // 重排已经成功了,❌ 不能落进下面那个「重排失败」的分支(失败条留着、再点一次只会 CAS 落空)。
        // 没叫醒宿主的后果只是慢:这条命令在下一个对账节拍被取走。
        turnFailureLog.error(
          { commandId: failure.commandId, err: String(notifyErr) },
          'requeued the command but could not notify the device runtime',
        )
      }
      // 重排成功即收起失败条。❌ 不在这里点亮「运行中」:重排只说明命令回到队列,不说明 agent 开跑;
      // 真开跑由宿主宣布,那条转变会自己把状态点变红。若这轮再失败,新的 error 流事件会重新落失败条。
      onDismiss()
    } catch (err) {
      // fail loud：重排本身失败（网络/RLS）→ 保留失败条可再点，原因进 console。
      console.error(`[agent-turn] retry requeue failed for ${failure.commandId}:`, err)
      setRetrying(false)
    }
  }

  return (
    <div data-testid="agent-turn-failure" data-chat-composer-notice="" style={{ flexShrink: 0 }}>
      <TurnFailureCard reason={turnFailureReasonFromError(failure.rawMessage)} placement="composer"
        agentId={failure.agentUserId} displayName={displayName} avatar={avatar}
        createdAt={new Date(failure.at).toISOString()} onDismiss={onDismiss} onOpenSettings={onOpenModel}
        onRetry={() => void handleRetry()} retrying={retrying} />
    </div>
  )
}
