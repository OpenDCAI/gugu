import { useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  EXTENSION_CONSENT_ANSWER_EVENT,
  EXTENSION_CONSENT_EVENT,
  type ExtensionConsentAnswerDetail,
  type ExtensionConsentEventDetail,
  type ExtensionConsentRequester,
} from '../../session/shared/extensions/host-actions'
import { useChatStore } from '../../store/chatContext'
import { Avatar } from '../Avatar'
import { Button } from '../ui/Button'
import { Sheet } from '../ui/Sheet'
import { ConsentBody } from './ConsentDetails'
import { MachineLines } from '../../session/renderer/features/remote-hosts/machine-picker'
import { ForumConsent } from './ForumConsent'
import { DispatchSheet } from '../chat/DispatchSheet'

type Ask = Extract<ExtensionConsentEventDetail, { type: 'ask' }>

/** D-31 The agent that asked, as the chat list draws it: its face beside 「〈agent〉要装 X」. */
function RequesterFace({ requester }: { requester: ExtensionConsentRequester }) {
  const { identitiesById } = useChatStore('identitiesById')
  const identity = requester.agentUserId ? identitiesById[requester.agentUserId] : undefined
  return (
    <span data-testid="extension-consent-requester" className="shrink-0">
      <Avatar size={32} name={requester.name} avatarUrl={identity?.avatar ?? null} seed={requester.agentUserId ?? undefined} isAgent />
    </span>
  )
}

/**
 * An install's consent, asked where the person is (摩擦单 F6): drawn by the shell over whatever is on
 * screen — the group chat, its side panel, the session page — and the view never changes for it. After
 * they answer they are where they were. The session page asks through EXTENSION_CONSENT_EVENT.
 */
export function ExtensionConsentSheet() {
  // 论坛 (9): the other things an App asks the person to consent to here — moving a bounty's community points, assigning an agent.
  // And whom a dispatch goes to when the App did not say (`gugu.dispatch(text)`): the same shell, the same promise.
  return (
    <>
      <InstallConsentSheet />
      <ForumConsent />
      <DispatchSheet />
    </>
  )
}

function InstallConsentSheet() {
  const { t } = useTranslation('messaging')
  const [ask, setAsk] = useState<Ask | null>(null)
  /** owner 10-16: the other computers ticked to install on too — none until the person ticks one. */
  const [alsoOn, setAlsoOn] = useState<string[]>([])
  const titleId = useId()

  useEffect(() => {
    const onEvent = (event: Event) => {
      const detail = (event as CustomEvent<ExtensionConsentEventDetail>).detail
      if (!detail) return
      if (detail.type === 'ask') {
        detail.shown = true
        setAlsoOn([])
        setAsk(detail)
      } else if (detail.type === 'close') {
        setAsk((current) => (current?.requestId === detail.requestId ? null : current))
      }
    }
    window.addEventListener(EXTENSION_CONSENT_EVENT, onEvent)
    return () => window.removeEventListener(EXTENSION_CONSENT_EVENT, onEvent)
  }, [])

  if (!ask) return null
  const answer = (outcome: ExtensionConsentAnswerDetail['outcome']) => {
    setAsk(null)
    const detail: ExtensionConsentAnswerDetail = {
      requestId: ask.requestId,
      outcome,
      ...(ask.alsoOn ? { alsoOn } : {}),
    }
    window.dispatchEvent(new CustomEvent(EXTENSION_CONSENT_ANSWER_EVENT, { detail }))
  }
  return (
    // The visible title names the sheet (`titleId`): without it the sheet adds a hidden copy, and the title is read twice.
    <Sheet onClose={() => answer('dismissed')} desktopWidth="440px" testId="extension-consent-sheet" titleId={titleId} zIndex="var(--z-settings-modal)">
      <div className="flex min-h-0 flex-1 flex-col gap-3 !p-5">
        <div className="flex items-center gap-2">
          {ask.requester ? <RequesterFace requester={ask.requester} /> : null}
          <div id={titleId} className="min-w-0 text-[length:var(--font-title)] font-semibold text-[var(--text-primary)]">
            {ask.title}
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-auto text-[length:var(--font-body)] text-[var(--text-secondary)]">
          <ConsentBody description={ask.description} details={ask.details} />
          {ask.given || ask.alsoOn?.length ? (
            // owner 10-27「不关心给哪些 agent，关心给哪些设备」: one list of computers. The one asked for is installed on; each
            // other one ticked is installed on too (owner 10-16). Who gets its tools is each computer's own install rule
            // (`InstallGrant`): a first install there gives every agent there, one installed already keeps what it gives — so
            // ticking a computer never widens who has it. Naming agents, groups and projects is the App page's.
            <fieldset className="!mt-3 flex flex-col gap-1" data-testid="extension-consent-devices">
              <legend className="text-[length:var(--font-body)] font-semibold text-[var(--text-primary)]">{t('chatArea.appEnable.devices')}</legend>
              {[{ id: '', label: ask.machine ?? t('chatArea.appEnable.machine'), disabledReason: undefined }, ...(ask.alsoOn ?? [])].map((machine) => (
                <label key={machine.id} className="flex items-center gap-2 py-1" title={machine.disabledReason}>
                  <input
                    type="checkbox"
                    data-testid={machine.id ? `extension-consent-also-on-${machine.id}` : 'extension-consent-device-target'}
                    disabled={!machine.id || machine.disabledReason !== undefined}
                    checked={!machine.id || alsoOn.includes(machine.id)}
                    onChange={(event) => setAlsoOn((ids) => (event.target.checked ? [...ids, machine.id] : ids.filter((id) => id !== machine.id)))}
                  />
                  <MachineLines label={machine.label} meta={machine.disabledReason ?? null} muted={machine.disabledReason !== undefined} />
                </label>
              ))}
              {ask.given ? <div data-testid="extension-consent-grant" className="px-1 pt-1 text-[length:var(--font-caption)] leading-normal text-[var(--text-tertiary)]">{ask.given.first ? t('chatArea.appEnable.devicesHint') : t('chatArea.appEnable.addsChat', { name: ask.given.chat.name })}</div> : null}
            </fieldset>
          ) : null}
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" data-testid="extension-consent-cancel" onClick={() => answer('declined')}>
            {ask.cancelLabel ?? t('common.cancel')}
          </Button>
          <Button data-testid="extension-consent-confirm" onClick={() => answer('confirmed')}>
            {ask.confirmLabel}
          </Button>
        </div>
      </div>
    </Sheet>
  )
}
