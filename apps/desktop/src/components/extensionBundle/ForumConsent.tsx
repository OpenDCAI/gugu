import { useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/Button'
import { Sheet } from '@/components/ui/Sheet'
import { rendererLogger } from '@/lib/log'
import { getRendererAccessToken } from '@/lib/sessionPublication'
import { APP_FORUM_CONSENT_EVENT, type AppForumConsentDetail } from '@/session/shared/extensions/app-runtime-protocol'
import { createAppForum } from '@/session/shared/extensions/app-forum-core'
import { ChatPickSheet } from '../chat/ChatPickSheet'
import { useOwnedAgents } from '../settings/channels/channelAgents'

const log = rendererLogger('forum')

/** The person signed in to this window: the sheet posts and settles as them, as the App's own calls do. */
const forum = createAppForum({
  async account() {
    const token = getRendererAccessToken()
    if (!token) throw new Error('Not signed in')
    return { token }
  },
})

/** The database's reason words a points sheet can meet, as the person reads them. */
const REASONS: ReadonlyArray<[string, string]> = [
  ['bounty_insufficient_points', 'insufficient'],
  ['bounty_active_limit', 'activeLimit'],
  ['bounty_award_too_early', 'tooEarly'],
  ['bounty_past_grace', 'pastGrace'],
  ['bounty_award_to_self', 'toSelf'],
  ['add up to the bounty', 'splitMismatch'],
  ['bounty_already_settled', 'settled'],
  ['account_too_new', 'accountTooNew'],
  ['blocked_by_poster', 'blocked'],
  ['owner_identity_limit', 'identityLimit'],
  ['post_closed', 'settled'],
]

/**
 * 论坛 (9): a bounty's community points move only behind this sheet, drawn by the host — never one an App draws. Posting a
 * bounty and settling one (accepting answers, or ending it without): the App's call came here (`gugu.forum.post` with a bounty,
 * `gugu.forum.award`); this does it if the person confirms, and the App hears the outcome from the forum's channel. Assigning
 * an agent too (`gugu.forum.assign`): the person picks one of their own agents in the host's pick sheet (ChatPickSheet, the
 * one a compose naming no place opens), so an App never lists them. Confirming
 * waits until it is really done; one that fails stays open saying why, ❌ closed as if it had worked.
 */
export function ForumConsent() {
  const { t } = useTranslation('messaging')
  const [ask, setAsk] = useState<AppForumConsentDetail | null>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const agents = useOwnedAgents()
  const [picked, setPicked] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const titleId = useId()

  useEffect(() => {
    const onAsk = (event: Event) => {
      const detail = (event as CustomEvent<AppForumConsentDetail>).detail
      if (!detail) return
      setFailed(null)
      setBusy(false)
      setPicked(detail.type === 'assign' ? detail.draft.preselect?.replace(/^user:/, '') ?? null : null)
      setQuery('')
      setAsk(detail)
    }
    window.addEventListener(APP_FORUM_CONSENT_EVENT, onAsk)
    return () => window.removeEventListener(APP_FORUM_CONSENT_EVENT, onAsk)
  }, [])

  if (!ask) return null
  const close = () => {
    if (!busy) setAsk(null)
  }
  const confirm = async () => {
    setBusy(true)
    setFailed(null)
    try {
      if (ask.type === 'bounty') await forum.createBountyPost(ask.draft)
      else if (ask.type === 'assign') await forum.assign(ask.draft.post, picked)
      else await forum.settle(ask.draft)
      setAsk(null)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log.warn({ error: message, type: ask.type }, 'forum points action failed')
      const reason = REASONS.find(([word]) => message.includes(word))?.[1]
      setFailed(reason ? t(`forum.consent.error.${reason}`) : t('forum.consent.failed'))
      setBusy(false)
    }
  }

  if (ask.type === 'assign') {
    const needle = query.trim().toLocaleLowerCase()
    return (
      <ChatPickSheet
        title={t('forum.consent.assignTitle')}
        onClose={close}
        testId="forum-assign"
        rows={agents
          .filter((agent) => !needle || agent.display_name.toLocaleLowerCase().includes(needle))
          .map((agent) => ({ id: agent.id, name: agent.display_name, avatar: { name: agent.display_name, avatarUrl: agent.avatar, seed: agent.id, isAgent: true } }))}
        selected={new Set(picked ? [picked] : [])}
        onToggle={setPicked}
        query={query}
        onQuery={setQuery}
        placeholder={t('forum.consent.searchAgents')}
        empty={t('forum.consent.noAgents')}
        above={<div className="text-[length:var(--font-body)] text-[var(--text-primary)]">{ask.draft.title}<p className="m-0 mt-1 text-[var(--text-secondary)]">{t('forum.consent.assignBody')}</p></div>}
        picked={t('forward.selected', { count: picked ? 1 : 0 })}
        actionLabel={t('forum.consent.assignConfirm')}
        actionDisabled={busy || !picked}
        onAction={() => void confirm()}
        error={failed}
        fullScreenMobile
      />
    )
  }
  const ending = ask.type === 'award' && ask.draft.awards.length === 0
  const title = ask.type === 'bounty' ? t('forum.consent.postTitle') : ending ? t('forum.consent.endTitle') : t('forum.consent.acceptTitle')
  const lines = ask.type === 'bounty'
    ? [
        ask.draft.title,
        t('forum.consent.reward', { amount: ask.draft.amount }),
        t('forum.consent.days', { count: ask.draft.days }),
        t(`forum.consent.visibility.${ask.draft.visibility}`),
      ]
    : [ask.draft.title, ...ask.draft.awards.map((award) => t('forum.consent.awardLine', { name: award.to, amount: award.amount }))]
  const body = ask.type === 'bounty' ? t('forum.consent.postBody', { amount: ask.draft.amount })
    : ending ? t('forum.consent.endBody') : t('forum.consent.acceptBody')
  const confirmLabel = ask.type === 'bounty' ? t('forum.consent.postConfirm') : ending ? t('forum.consent.endConfirm') : t('forum.consent.acceptConfirm')

  return (
    // The same sheet the install consent beside it draws (ExtensionConsentSheet): one look for every consent an App asks for.
    <Sheet onClose={close} desktopWidth="420px" testId="forum-consent" titleId={titleId}>
      <div className="flex min-h-0 flex-1 flex-col gap-3 !p-5">
        <div id={titleId} className="min-w-0 text-[length:var(--font-title)] font-semibold text-[var(--text-primary)]">{title}</div>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto text-[length:var(--font-body)] text-[var(--text-secondary)]">
          <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[var(--text-primary)]">
            {lines.map((line, index) => <li key={`${index}:${line}`}>{line}</li>)}
          </ul>
          <p className="m-0">{body}</p>
          {failed ? <p className="m-0 text-[var(--danger)]" role="alert">{failed}</p> : null}
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" disabled={busy} onClick={close} data-testid="forum-consent-cancel">{t('forum.consent.cancel')}</Button>
          <Button variant={ending ? 'danger' : 'primary'} disabled={busy} onClick={() => void confirm()} data-testid="forum-consent-confirm">
            {confirmLabel}
          </Button>
        </div>
      </div>
    </Sheet>
  )
}
