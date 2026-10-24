import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { QuestionCard } from '@gugu/core/shared/ui/taskCardModels'
import type { Settlement } from '@gugu/session-core/session-record/contract'
import { useTimelineSession } from '@/mobile/agent-watch/use-timeline-session'
import { useDevicesStore } from '../../store/devicesContext'
import { useChatStore } from '../../store/chatContext'
import { useAuth } from '../../store/auth'
import { questionAnsweredText } from '../../lib/questionCardAnswer'
import { composerCardCopy } from '../../lib/composerCardCopy'
import { assistantTimelineClient } from '../assistant/assistantTimelineClient'
import { AgentHarnessIcon } from '../AgentHarnessIdentity'
import { Button } from '../ui/Button'
import { openTaskCardSession } from './openTaskCardSession'
import '../../i18n/registerAssistantCatalog'

/**
 * gugu-dev#181 ⑨ 问题卡:agent 在群里问它的主人,引用它正回的那一条。与任务卡同一个面:是什么(右上时刻)、问题、选项、一行状态。
 * 等没等、答了什么,只读那条会话的结算(本机或别的机器,与助理进度同一个读口);这条消息发出去以后没人改它。
 * 选项 = 主人引用这张卡回一句、正文就是选项名 —— 与手打的引用回复同一个动作(questionCardAnswer.ts)。
 * 不是问我的(群里的同事),只有问题和选项;问了几道、或能多选的,点卡到会话里答。
 */
export function QuestionCardView({ card, chatId, messageId, agentUserId, time }: {
  card: QuestionCard
  chatId: string
  messageId: string
  agentUserId: string
  time: string
}) {
  const { t } = useTranslation('assistant')
  const { user } = useAuth()
  const { devices } = useDevicesStore()
  const device = devices.find((row) => row.device_id === card.deviceId)
  const mine = user?.id === card.ownerUserId && Boolean(device)
  const settlement = useQuestionSettlement(card, mine ? device?.is_current_device === true : null)
  const openable = mine && device?.is_current_device === true && card.options.length === 0
  const Root = openable ? 'button' : 'div'
  return (
    <Root
      type={openable ? 'button' : undefined}
      data-testid="composer-card"
      data-card-type="question"
      title={openable ? t('message.taskCard.open', { ns: 'messaging' }) : undefined}
      onClick={openable ? () => openTaskCardSession(card) : undefined}
      className="box-border flex w-[300px] max-w-full flex-col gap-2 rounded-xl border border-[var(--border)] bg-[var(--bg-primary)] p-3 text-left enabled:cursor-pointer enabled:hover:border-[var(--border-strong)]"
    >
      <span className="flex h-6 items-center gap-2">
        <span aria-hidden className="grid size-6 shrink-0 place-items-center rounded-[var(--radius-document)] border border-[var(--border)]">
          <AgentHarnessIcon agentId={agentUserId} size={13} />
        </span>
        <span className="text-[var(--font-body)] font-semibold">{t(composerCardCopy.question.head, { ns: 'messaging' })}</span>
        <span className="ml-auto shrink-0 text-[var(--font-caption)] text-[var(--muted-fg)]">{time}</span>
      </span>
      <span className="line-clamp-6 whitespace-pre-wrap break-words text-[var(--font-prose)] leading-[var(--lh-prose)]">{card.text}</span>
      {card.options.length > 0 && <QuestionCardOptions card={card} chatId={chatId} messageId={messageId} answerable={mine && settlement?.state === 'pending'} />}
      {mine && <QuestionCardState settlement={settlement} inSession={card.options.length === 0} />}
    </Root>
  )
}

function QuestionCardOptions({ card, chatId, messageId, answerable }: { card: QuestionCard; chatId: string; messageId: string; answerable: boolean }) {
  const { sendMessageToChat } = useChatStore('sendMessageToChat')
  const [sending, setSending] = useState(false)
  const pick = (option: string) => {
    setSending(true)
    void sendMessageToChat(chatId, option, { replyToMessageId: messageId }).finally(() => setSending(false))
  }
  return (
    <span className="flex flex-wrap gap-1">
      {card.options.map((option) => (
        <Button key={option} variant="secondary" size="sm" disabled={!answerable || sending} onClick={() => pick(option)}>{option}</Button>
      ))}
    </span>
  )
}

/** 一行状态:待你回答 = 琥珀点(与侧栏「需要你」同一个色调);答了 =「已回答：X」;收回了 = 这次提问已结束。 */
function QuestionCardState({ settlement, inSession }: { settlement: Settlement | null; inSession: boolean }) {
  const { t } = useTranslation('assistant')
  if (!settlement) return null
  if (settlement.state === 'pending') {
    return (
      <span className="flex h-5 items-center gap-2 text-[var(--font-caption)] text-[var(--muted-fg)]">
        <span aria-hidden className="mx-[3px] size-2 shrink-0 rounded-full bg-[var(--agent-tone-needs-user)]" />
        {inSession ? t('message.taskCard.questionInSession', { ns: 'messaging' }) : t('question.waiting')}
      </span>
    )
  }
  const answered = settlement.state === 'resolved' ? questionAnsweredText(settlement.optionId) : ''
  return (
    <span className="truncate text-[var(--font-caption)] text-[var(--muted-fg)]">
      {answered ? t('message.taskCard.questionAnswered', { ns: 'messaging', answer: answered }) : t('question.withdrawn')}
    </span>
  )
}

/** 这道题在它那条会话里的结算;`local` = null 时不读(不是问我的)。 */
function useQuestionSettlement(card: QuestionCard, local: boolean | null): Settlement | null {
  const read = useTimelineSession(assistantTimelineClient(local === true), 'question-card', card.deviceId, card.sessionId, local !== null)
  return read.timeline.settlements[card.questionId] ?? null
}
