import { createContext, useContext, useState, type ReactElement, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { makeAssistantDataUI } from '@assistant-ui/react'
import type { ToolCallItem } from '@gugu/session-core/acp/client'
import {
  remoteSettlementGap,
  type QuestionAnswer,
  type Settlement,
  type SettlementQuestion,
  type SettlementResponse,
  type SessionpageSessionSummary,
} from '@gugu/session-core/session-record/contract'
import { HelpCircle, ShieldCheck } from '@/lib/icons'
import { Button } from '@/components/ui/Button'
import { Field } from '@/components/ui/Field'
import { MOBILE_RESPONDER_ID } from './useAgentWatchSession'
import { appInstallAskOf } from '@/session/shared/extensions/host-actions'
import { answerAppInstall, appInstallWords } from '@/session/renderer/features/extensions/app-install-approval'
import { translateSessionMessage } from '@/session/renderer/localization/locale-store'
import { QUESTION_DATA_PART } from './thread-messages'

/**
 * 审批 / 提问卡 —— 手机端**唯一**还活着的自绘转录部件。
 *
 * 手机端的转录本身用的是 assistant-ui 的 `Thread`(见 `AgentThread.tsx`);卡就画在问出它的那次工具调用的位置
 * (`QuestionDataUI`),等答是表单、答完是一条记录,活着与刷新后同一个样子;流里没有那一行的待答项才钉在末尾。
 *
 * ❌ 本文件原来还导出一个 `TimelineView`(以及它私有的 `TurnView` / `ItemView` /
 * `ToolNodeView`):自绘的气泡、工具卡、思考行、轮结局那一整套。2026-09-22 删掉 ——
 * **全仓没有任何地方 import 它**(唯一的 import 在 `AgentThread.tsx`,只取 `SettlementCard`),
 * 它对应的那套 CSS(`.gg-aw-msg` / `.gg-aw-tool*` / `.gg-aw-turn` …)一并从
 * `agent-watch.css` 删掉。走不到的渲染路径不是零成本的:本轮的 UI 对齐就把那套规则
 * 读成了「手机端气泡的现状」。
 */

/**
 * 卡要的那几样:结算、这条会话的腿、在答哪一条、作答。走 context(AgentThread 给),❌ 进数据组件的闭包 ——
 * 闭包一变组件就是新的,卡会重挂,表单里已经选了的就没了。
 */
export type SettlementSlotValue = {
  settlements: Readonly<Record<string, Settlement>>
  runtime: SessionpageSessionSummary['runtime']
  machine?: string
  respondingItemId: string | null
  onRespond: (input: SettlementResponse) => void
}
const SettlementSlot = createContext<SettlementSlotValue | null>(null)

export function SettlementSlotProvider({ value, children }: { value: SettlementSlotValue; children: ReactNode }) {
  return <SettlementSlot.Provider value={value}>{children}</SettlementSlot.Provider>
}

/** 问用户的那次工具调用,画成它的卡(thread-messages 只在有结算时交这一种 part)。 */
function QuestionPart({ data }: { data: ToolCallItem }): ReactElement | null {
  const slot = useContext(SettlementSlot)
  const settlement = slot?.settlements[data.toolCallId]
  if (!slot || !settlement) return null
  return (
    <SettlementCard
      settlement={settlement}
      runtime={slot.runtime}
      machine={slot.machine}
      busy={slot.respondingItemId === settlement.itemId}
      onRespond={slot.onRespond}
    />
  )
}

export const QuestionDataUI = makeAssistantDataUI<ToolCallItem>({ name: QUESTION_DATA_PART, render: QuestionPart })

function responderName(by: string | null, t: (key: string) => string): string | null {
  if (!by) return null
  if (by === MOBILE_RESPONDER_ID) return t('agentWatch.settlement.byMobile')
  if (by === 'desktop') return t('agentWatch.settlement.byDesktop')
  return by
}

export function SettlementCard({
  settlement,
  runtime,
  busy,
  onRespond,
  machine,
  source,
}: {
  settlement: Settlement
  /** The computer the session runs on: an App install's 「给哪些 agent」 lists that one's agents (D-31). */
  machine?: string
  /** Optional task provenance inside the same actionable card. */
  source?: ReactNode
  /** 这条会话的腿。答不答得了与写侧同一条判据(`remoteSettlementGap`)。 */
  runtime: SessionpageSessionSummary['runtime']
  busy: boolean
  onRespond: (input: SettlementResponse) => void
}) {
  const { t } = useTranslation('main')
  const kind = settlement.kind ?? 'permission'
  const options = settlement.options ?? []
  const pending = settlement.state === 'pending'
  const by = responderName(settlement.resolvedBy, t)
  // 宿主能往终端写键的提问带着整份题目,按一套表单画;别的提问仍是第一题的一排按钮。
  const questions = settlement.questions
  const gap = pending ? remoteSettlementGap(runtime, kind, questions, settlement.host) : null
  const multi = (questions?.length ?? 0) > 1
  // D-31 An App install the host asks for this agent: who asks for what; 「查看并安装」 opens this phone's own sheet first.
  const install = appInstallAskOf(settlement.host)
  const words = install ? appInstallWords(install, translateSessionMessage) : null
  const answer = (optionId: string) => {
    if (!install) {
      onRespond({ itemId: settlement.itemId, optionId, kind })
      return
    }
    void answerAppInstall({
      itemId: settlement.itemId,
      ask: install,
      optionId,
      ...(machine ? { machine } : {}),
      respond: async ({ optionId: picked, digest, enableIn }) =>
        onRespond({ itemId: settlement.itemId, optionId: picked, kind, ...(digest ? { digest } : {}), ...(enableIn ? { enableIn } : {}) }),
    })
  }

  return (
    <div
      className="gg-aw-card"
      data-state={settlement.state}
      data-item-id={settlement.itemId}
      data-testid="agent-watch-settlement"
    >
      {source}
      <div className="gg-aw-card-title">
        {kind === 'question' ? <HelpCircle /> : <ShieldCheck />}
        {' '}
        {!multi
          ? words?.title ?? settlement.title ?? t(`agentWatch.settlement.${kind}`)
          : pending
            ? t('agentWatch.settlement.question')
            : t('agentWatch.settlement.questionSet', { n: questions?.length ?? 0 })}
      </div>
      {settlement.detail && !multi ? <div className="gg-aw-card-detail">{settlement.detail}</div> : null}

      {settlement.state === 'cancelled' ? (
        <div className="gg-aw-card-answered">{t('agentWatch.settlement.cancelled')}</div>
      ) : null}

      {/* 已了结:说清楚是哪一端答的。❌ 不留一排按下去必被拒的按钮。 */}
      {settlement.state === 'resolved' ? (
        <div className="gg-aw-card-answered" data-testid="agent-watch-settlement-answered">
          {by
            ? t('agentWatch.settlement.answeredBy', { by })
            : t('agentWatch.settlement.answeredByUnknown')}
        </div>
      ) : null}

      {/* 这条腿上手机答不了(#6739)—— 一开始就说去哪答,❌ 摆一排按下去必被拒的按钮。 */}
      {gap ? (
        <div className="gg-aw-card-answered" data-testid="agent-watch-settlement-answer-elsewhere">
          {t(runtime === 'pty' ? 'agentWatch.settlement.answerInTerminal' : 'agentWatch.settlement.answerOnDesktop')}
        </div>
      ) : null}

      {/* 还在等人答、但机器没把可选项发过来 —— 如实说去哪答,❌ 不造 optionId 摆按钮。 */}
      {pending && !gap && questions ? (
        <QuestionForm
          questions={questions}
          busy={busy}
          onSubmit={(answers) => onRespond({ itemId: settlement.itemId, kind: 'question', answers })}
          onDecline={() => onRespond({ itemId: settlement.itemId, kind: 'question', decline: true })}
        />
      ) : null}

      {pending && !gap && !questions && options.length === 0 ? (
        <div className="gg-aw-card-answered">{t('agentWatch.settlement.noOptions')}</div>
      ) : null}

      {pending && !gap && !questions && options.length > 0 ? (
        <div className="gg-aw-card-options">
          {options.map((option) => (
            <Button
              key={option.optionId}
              variant={option.kind?.startsWith('allow') ? 'primary' : 'secondary'}
              size="option"
              disabled={busy}
              data-option-id={option.optionId}
              onClick={() => answer(option.optionId)}
              title={option.description}
            >
              <span className="gg-aw-option-name">{words?.label(option.optionId) ?? option.name}</span>
              {/* 几个选项在小屏上常常只差一两个词,没有这句说明就只能靠猜 —— 猜错 = 替 agent 做了错决定。 */}
              {option.description ? (
                <span className="gg-aw-option-desc">{option.description}</span>
              ) : null}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/**
 * 终端选择器的题目,各题型共用这一套:每题一列选项(单选互斥、多选可勾可不勾),单选多一格「自己写」。
 * 怎么变成键由宿主按这家的声明编;编不出来的(比如结尾反斜杠)宿主一个键都不写就拒,原因照实显示。
 */
function QuestionForm({
  questions,
  busy,
  onSubmit,
  onDecline,
}: {
  questions: readonly SettlementQuestion[]
  busy: boolean
  onSubmit: (answers: QuestionAnswer[]) => void
  onDecline: () => void
}) {
  const { t } = useTranslation('main')
  const [answers, setAnswers] = useState<QuestionAnswer[]>(() => questions.map(() => ({ selected: [] })))
  const put = (index: number, next: QuestionAnswer) =>
    setAnswers((current) => current.map((answer, i) => (i === index ? next : answer)))
  const complete = answers.every((answer, i) =>
    questions[i].multiSelect || answer.selected.length === 1 || !!answer.other?.trim())

  return (
    <>
      {questions.map((question, index) => {
        const answer = answers[index]
        const writing = answer.other !== undefined
        return (
          <div
            key={index}
            className="gg-aw-card-options"
            role={question.multiSelect ? 'group' : 'radiogroup'}
            aria-label={question.question}
          >
            {questions.length > 1 ? <div className="gg-aw-card-detail">{question.question}</div> : null}
            {question.options.map((option) => {
              const checked = answer.selected.includes(option.optionId)
              return (
                <Button
                  key={option.optionId}
                  variant="option"
                  size="option"
                  role={question.multiSelect ? 'checkbox' : 'radio'}
                  aria-checked={checked}
                  disabled={busy}
                  data-option-id={option.optionId}
                  onClick={() => put(index, !question.multiSelect
                    ? { selected: [option.optionId] }
                    : {
                        ...answer,
                        selected: checked
                          ? answer.selected.filter((label) => label !== option.optionId)
                          : [...answer.selected, option.optionId],
                      })}
                >
                  <span className="gg-aw-option-name">{option.name}</span>
                  {option.description ? <span className="gg-aw-option-desc">{option.description}</span> : null}
                </Button>
              )
            })}
            {/* 单选:「自己写」与选项互斥;多选:它是又一个勾,勾上就多写一段,已勾的选项不动。 */}
            <Button
              variant="option"
              size="option"
              role={question.multiSelect ? 'checkbox' : 'radio'}
              aria-checked={writing}
              disabled={busy}
              data-testid="agent-watch-settlement-write-own"
              onClick={() => put(index, !question.multiSelect
                ? { selected: [], other: answer.other ?? '' }
                : writing ? { selected: answer.selected } : { selected: answer.selected, other: '' })}
            >
              <span className="gg-aw-option-name">{t('agentWatch.settlement.writeOwn')}</span>
            </Button>
            {writing ? (
              <Field.Root>
                <Field.Input
                  render={<textarea rows={3} />}
                  value={answer.other}
                  disabled={busy}
                  data-testid="agent-watch-settlement-other"
                  onChange={(e: { target: { value: string } }) => put(index, { selected: question.multiSelect ? answer.selected : [], other: e.target.value })}
                />
              </Field.Root>
            ) : null}
          </div>
        )
      })}
      <div className="gg-aw-card-options">
        <Button
          variant="primary"
          size="lg"
          disabled={busy || !complete}
          data-testid="agent-watch-settlement-submit"
          onClick={() => onSubmit(answers)}
        >
          {t('agentWatch.settlement.submit')}
        </Button>
        <Button variant="secondary" size="lg" disabled={busy} data-testid="agent-watch-settlement-decline" onClick={onDecline}>
          {t('agentWatch.settlement.decline')}
        </Button>
      </div>
    </>
  )
}
