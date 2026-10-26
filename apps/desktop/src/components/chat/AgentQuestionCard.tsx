import { rendererLogger } from '@/lib/log';
import { messageForUser } from '@/lib/userFacingError';
import { Button } from '../ui/Button'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { QuestionAnswer, Settlement, SessionpageSessionRespondResult } from '@gugu/session-core/session-record/contract'
import { useToast } from '../toastContext'
import { Markdown } from '../markdown/Markdown'
import { agentQuestionDraftKey, questionAnswerReady } from '../../lib/agentQuestion'
import './agent-question-card.css'

type Draft = { step: number; answers: QuestionAnswer[]; custom: boolean[]; deferred: boolean }
const drafts = new Map<string, Draft>()

/** The host settles once; selecting or deferring never sends an answer. */
export function AgentQuestionCard({ scope, settlement, unavailable = false, mobile = false, respond }: {
  scope: string
  settlement: Settlement
  unavailable?: boolean
  mobile?: boolean
  respond: (answers: readonly QuestionAnswer[]) => Promise<SessionpageSessionRespondResult>
}) {
  const { t } = useTranslation('assistant')
  const { toast } = useToast()
  const questions = settlement.questions ?? []
  const key = agentQuestionDraftKey(scope, settlement)
  const [draft, setDraft] = useState<Draft>(() => drafts.get(key) ?? {
    step: 0, answers: questions.map(() => ({ selected: [] })), custom: questions.map(() => false), deferred: false,
  })
  const [busy, setBusy] = useState(false)
  const [accepted, setAccepted] = useState(false)
  const [observed, setObserved] = useState<Settlement | null>(null)
  const update = (next: Draft) => { drafts.set(key, next); setDraft(next) }
  const current = observed ?? settlement
  useEffect(() => { if (current.state !== 'pending') drafts.delete(key) }, [key, current.state])
  if (current.state !== 'pending' || accepted) return null
  if (questions.length === 0) return null
  if (draft.deferred) return <div className="agent-question-receipt" data-testid="agent-question-deferred">
    <span>{t('question.waiting')}</span><Button variant="ghost" size="sm" onClick={() => update({ ...draft, deferred: false })}>{t('question.resume')}</Button>
  </div>
  const question = questions[draft.step]!
  const answer = draft.answers[draft.step]!
  const replaceAnswer = (next: QuestionAnswer, custom: boolean) => update({ ...draft,
    answers: draft.answers.map((old, index) => index === draft.step ? next : old),
    custom: draft.custom.map((old, index) => index === draft.step ? custom : old),
  })
  const ready = questionAnswerReady(question, answer, draft.custom[draft.step] ?? false)
  const submit = async () => {
    if (busy || unavailable || !questions.every((item, index) => questionAnswerReady(item, draft.answers[index]!, draft.custom[index] ?? false))) return
    setBusy(true)
    try {
      const result = await respond(draft.answers)
      if (result.accepted) { setAccepted(true); drafts.delete(key) }
      else { setObserved(result.settlement); toast(t('question.noLongerWaiting'), 'info') }
    } catch (error) { rendererLogger('actions/AgentQuestionCard').error({ error: error }, 'action failed'); toast(t('question.failed'), 'error', messageForUser(error)) }
    finally { setBusy(false) }
  }
  return <section className="agent-question-card" aria-label={t('question.title')} data-mobile={mobile || undefined} data-testid="agent-question-card" aria-busy={busy}>
    <div className="agent-question-card__head"><span>{question.header || t('question.title')}</span><span>{draft.step + 1} / {questions.length}</span></div>
    <div className="agent-question-card__question"><Markdown trust="chat" content={question.question} /></div>
    <div className="agent-question-card__options" role="group" aria-label={question.question}>
      {question.options.map((option, index) => <Button variant="ghost" size="sm" key={option.optionId} className="agent-question-card__option"
        aria-pressed={answer.selected.includes(option.optionId)} disabled={busy || unavailable}
        onClick={() => replaceAnswer({ selected: question.multiSelect
          ? answer.selected.includes(option.optionId) ? answer.selected.filter((id) => id !== option.optionId) : [...answer.selected, option.optionId]
          : [option.optionId], ...(question.multiSelect && answer.other ? { other: answer.other } : {}) }, question.multiSelect && draft.custom[draft.step] === true)}>
        <span className="agent-question-card__number" aria-hidden="true">{index + 1}</span>
        <span>{option.name}</span>{option.description && <span className="agent-question-card__detail">{option.description}</span>}
        <span className="agent-question-card__mark" aria-hidden="true" />
      </Button>)}
      <Button variant="ghost" size="sm" className="agent-question-card__option" aria-pressed={draft.custom[draft.step]}
        disabled={busy || unavailable} onClick={() => replaceAnswer({ selected: question.multiSelect ? answer.selected : [], other: answer.other ?? '' }, true)}>
        <span className="agent-question-card__number" aria-hidden="true">{question.options.length + 1}</span><span>{t('question.other')}</span><span className="agent-question-card__mark" aria-hidden="true" />
      </Button>
    </div>
    {draft.custom[draft.step] && <textarea className="agent-question-card__custom" aria-label={t('question.other')} value={answer.other ?? ''}
      disabled={busy || unavailable} onChange={(event) => replaceAnswer({ ...answer, other: event.target.value }, true)} autoFocus />}
    {unavailable && <p className="agent-question-card__unavailable" role="status">{t('question.unavailable')}</p>}
    <div className="agent-question-card__footer">
      <Button variant="ghost" size="sm" className="agent-question-card__later" disabled={busy} onClick={() => update({ ...draft, deferred: true })}>{t('question.later')}</Button>
      {draft.step > 0 && <Button variant="ghost" size="sm" disabled={busy} onClick={() => update({ ...draft, step: draft.step - 1 })}>{t('question.previous')}</Button>}
      <Button variant="primary" size="sm" className="agent-question-card__submit" disabled={!ready || busy || unavailable}
        onClick={() => draft.step < questions.length - 1 ? update({ ...draft, step: draft.step + 1 }) : void submit()}>
        {t(busy ? 'question.submitting' : draft.step < questions.length - 1 ? 'question.next' : 'question.submit')}
      </Button>
    </div>
  </section>
}
