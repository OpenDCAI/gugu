// #2115 普通 ACP 回合失败条：composer 上方浮动条同槽位（RunningTokenBar 的失败态邻居，flexShrink:0
// 兄弟，不 overlay 消息列表）。「{name} 回复失败：{人话}」+ 重试 + 关闭——重试 = CAS error→pending
// 重排原 deliver 命令（真重投递，❌ 假按钮）；原始错误只进 console（useAgentTurnFailure 已记）。
// 视觉复用聊天上下文的轻量通知：短说明与真实操作，不把原始诊断放进正文或悬浮提示。

import { useState, type ReactNode } from 'react'
import { AlertTriangle, X } from '@/lib/icons'
import { agentTurnFailureNeedsModelChoice, agentTurnFailureUserMessage, type AgentTurnFailure } from '../lib/agentTurnFailure'
import { rendererLogger } from '../lib/log'
import { requeueErroredDeviceCommand } from '../lib/supabase'
import { platform } from '../platform'
import { useAgentTurnFailure } from '../hooks/useAgentTurnFailure'
import { useTranslation } from 'react-i18next'
import { useContactsStore } from '../store/contactsContext'
import { AgentSettingsModal } from './agentsettings/AgentSettingsModal'
import { Button } from './ui/Button'
import { useStoredAgentTurnFailure } from '../hooks/useStoredAgentTurnFailure'

type AgentTurnFailureSlotProps = {
  chatId: string | null
  threadRootId: string | null
  profiles: Record<string, { displayName?: string | null; avatar?: string | null } | undefined>
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
  const stored = useStoredAgentTurnFailure(chatId, threadRootId, contacts.filter((contact) => contact.type === 'agent' && profiles[contact.id]).map((contact) => contact.id))
  const failure = (local.failure && !stored.isMuted(local.failure) ? local.failure : null) ?? stored.failure
  const [modelOpen, setModelOpen] = useState(false)
  if (!chatId) return null
  if (!failure) return stored.readFailed ? <><style>{STYLE}</style><div data-chat-composer-notice="" className="atf-bar" role="status"><span className="atf-msg">{t('agent.turnFailure.statusReadFailed')}</span><Button variant="ghost" size="sm" onClick={stored.retry}>{t('agent.turnFailure.retry')}</Button></div></> : null
  const profile = profiles[failure.agentUserId]
  const contact = contacts.find((entry) => entry.id === failure.agentUserId)
  return (
    <>
    <AgentTurnFailureBar
      failure={failure}
      displayName={profile?.displayName ?? t('agent.fallbackName')}
      avatar={profile?.avatar ?? null}
      onDismiss={() => { local.dismiss(); stored.dismiss(failure.commandId) }}
      onClose={() => { local.dismiss(); stored.dismiss(failure.commandId); stored.mute(failure) }}
      onOpenModel={contact ? () => setModelOpen(true) : undefined}
    />
    {modelOpen && contact ? <AgentSettingsModal agent={contact} initialTab="aimodel" onClose={() => setModelOpen(false)} /> : null}
    </>
  )
}

const turnFailureLog = rendererLogger('agent/turn-failure')

const STYLE = `
.atf-bar{display:flex;align-items:center;gap:8px;margin:6px 14px;padding:10px 12px;border:1px solid var(--border-subtle);border-radius:var(--radius-document);background:var(--bg-secondary);font-size:var(--font-body);color:var(--text-secondary);flex-shrink:0;min-width:0}
.atf-msg{flex:1;min-width:0;line-height:var(--lh-body);overflow-wrap:anywhere}
.atf-nm{color:var(--faint-fg);flex-shrink:0}
.atf-btn{flex-shrink:0;border:none;background:none;padding:2px 6px;border-radius:6px;font-size:var(--font-body);color:var(--text-secondary);cursor:pointer}
.atf-btn:hover{background:var(--hover);color:var(--text-primary)}
.atf-btn:active{background:var(--press)}
.atf-btn[disabled]{opacity:.5;cursor:default}
.atf-x{flex-shrink:0;border:none;background:none;padding:2px 5px;border-radius:6px;font-size:var(--font-body);color:var(--text-tertiary);cursor:pointer;line-height:1}
.atf-x:hover{background:var(--hover);color:var(--text-primary)}
.atf-x:active{background:var(--press)}
`

export function AgentTurnFailureBar({
  failure,
  displayName,
  onDismiss,
  onClose = onDismiss,
  onOpenModel,
}: {
  failure: AgentTurnFailure
  /** 由调用方（ChatAreaPanel）从成员档案解析；解析不到时传兜底名。 */
  displayName: string
  avatar: string | null
  onDismiss: () => void
  /** 用户点 ×：额度/模型类失败会就此静音到这位 agent 下次投递成功（agentTurnFailureMute）；重试成功只走 onDismiss。 */
  onClose?: () => void
  onOpenModel?: () => void
}) {
  const { t } = useTranslation('messaging')
  const [retrying, setRetrying] = useState(false)
  const userMessage = agentTurnFailureUserMessage(failure.rawMessage)
  const detail = failure.rawMessage.trim()

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
      <style>{STYLE}</style>
      <div className="atf-bar" role="status" aria-live="polite" aria-label={userMessage}>
        <AlertTriangle size={16} className="shrink-0 text-[var(--warn)]" aria-hidden />
        <span className="atf-nm">{displayName}</span>
        <span
          className="atf-msg"
          aria-label={userMessage}
        >
          {userMessage}
        </span>
        {onOpenModel && agentTurnFailureNeedsModelChoice(detail) ? (
          <Button variant="ghost" size="sm" className="atf-btn" onClick={onOpenModel} data-testid="agent-turn-failure-model">
            {t('agent.turnFailure.changeModel')}
          </Button>
        ) : null}
        <Button variant="ghost" size="sm" className="atf-btn" onClick={() => void handleRetry()} disabled={retrying} data-testid="agent-turn-failure-retry">
          {retrying ? t('agent.turnFailure.retrying') : t('agent.turnFailure.retry')}
        </Button>
        <Button variant="ghost" size="icon" className="atf-x" onClick={onClose} aria-label={t('common.close')} data-testid="agent-turn-failure-dismiss">
          <X size={14} aria-hidden />
        </Button>
      </div>
    </div>
  )
}
