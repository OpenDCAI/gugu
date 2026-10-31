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
import { MachineRow } from '../../session/renderer/features/remote-hosts/machine-picker'
import { localMachineChoice, machineAcceptsWork, machineChoiceFromHost, machineMeta, type MachineChoice } from '../../session/renderer/features/remote-hosts/machine-choice'
import { remoteHostsStore } from '../../session/renderer/features/remote-hosts/remote-hosts-store'
import { translateSessionMessage } from '../../session/renderer/localization/locale-store'
import { Check } from '../../lib/icons'
import { ForumConsent } from './ForumConsent'
import { DispatchSheet } from '../chat/DispatchSheet'

type Ask = Extract<ExtensionConsentEventDetail, { type: 'ask' }>

/** Another of the person's computers as the machine picker draws it; one this window does not follow yet, by its name alone. */
function hostChoice(id: string, label: string): MachineChoice {
  const host = remoteHostsStore.hosts.get(id)
  return host ? machineChoiceFromHost(host.device, remoteHostsStore.connectionState(id)) : { id, label, isLocal: false, isOnline: true }
}

/** The computer asked for: this one, or the one named (another desktop's install, an agent's on its computer). */
function targetChoice(machine: string | undefined, thisComputer: string): MachineChoice {
  if (!machine) return localMachineChoice('', thisComputer)
  const host = [...remoteHostsStore.hosts.values()].find(({ device }) => device.label === machine)
  return host ? hostChoice(host.device.id, machine) : { id: '', label: machine, isLocal: false, isOnline: true }
}

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
  /** Every ask not yet answered, oldest first: a second one waits its turn, ❌ drawn over the first and leaving it unanswered. */
  const [asks, setAsks] = useState<Ask[]>([])
  const ask = asks[0] ?? null
  /** owner 10-16: the other computers ticked to install on too — none until the person ticks one. */
  const [alsoOn, setAlsoOn] = useState<string[]>([])
  const titleId = useId()
  // Each ask starts with none ticked.
  useEffect(() => setAlsoOn([]), [ask?.requestId])

  useEffect(() => {
    const onEvent = (event: Event) => {
      const detail = (event as CustomEvent<ExtensionConsentEventDetail>).detail
      if (!detail) return
      if (detail.type === 'ask') {
        detail.shown = true
        setAsks((now) => (now.some((one) => one.requestId === detail.requestId) ? now : [...now, detail]))
      } else if (detail.type === 'close') {
        setAsks((now) => now.filter((one) => one.requestId !== detail.requestId))
      }
    }
    window.addEventListener(EXTENSION_CONSENT_EVENT, onEvent)
    return () => window.removeEventListener(EXTENSION_CONSENT_EVENT, onEvent)
  }, [])

  if (!ask) return null
  const answer = (outcome: ExtensionConsentAnswerDetail['outcome']) => {
    setAsks((now) => now.filter((one) => one.requestId !== ask.requestId))
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
          {ask.alsoOn?.length ? (
            // owner 10-27「不关心给哪些 agent，关心给哪些设备」: one list of computers, each row the machine picker's own
            // (`MachineRow`); the only difference here is the tick. The one asked for is installed on; each other one ticked is
            // installed on too (owner 10-16). Offline ones are listed, greyed, as everywhere a machine is picked. With no other
            // computer there is nothing to choose: no list (the title and the band say which computer).
            <fieldset className="!mt-3 flex flex-col" data-testid="extension-consent-devices">
              <legend className="pb-1 text-[length:var(--font-body)] font-semibold text-[var(--text-primary)]">{t('chatArea.appEnable.devices')}</legend>
              {[{ id: '', choice: targetChoice(ask.machine, t('chatArea.appEnable.machine')), disabledReason: undefined as string | undefined },
                ...ask.alsoOn.map((machine) => ({ id: machine.id, choice: hostChoice(machine.id, machine.label), disabledReason: machine.disabledReason }))].map(({ id, choice, disabledReason }) => {
                const blocked = !id || disabledReason !== undefined || !machineAcceptsWork(choice) || choice.cloudComputer !== undefined
                const ticked = !id || alsoOn.includes(id)
                return (
                  <label
                    key={id}
                    data-device-id={id}
                    title={disabledReason}
                    className={`flex min-h-8 items-center gap-2 rounded-sm px-2 py-1 text-sm text-foreground ${blocked ? (id ? 'opacity-50' : '') : 'cursor-pointer hover:bg-row-hover'}`}
                  >
                    <input
                      type="checkbox"
                      className="sr-only"
                      data-testid={id ? `extension-consent-also-on-${id}` : 'extension-consent-device-target'}
                      disabled={blocked}
                      checked={ticked}
                      onChange={(event) => setAlsoOn((ids) => (event.target.checked ? [...ids, id] : ids.filter((one) => one !== id)))}
                    />
                    <MachineRow
                      machine={choice}
                      meta={disabledReason ?? machineMeta(choice, translateSessionMessage)}
                      trailing={<Check aria-hidden="true" className={`size-3.5 ${ticked ? '' : 'invisible'}`} />}
                    />
                  </label>
                )
              })}
            </fieldset>
          ) : null}
          {ask.given ? <div data-testid="extension-consent-grant" className={`!mt-2 ${ask.alsoOn?.length ? 'px-2' : ''} text-[length:var(--font-caption)] leading-normal text-[var(--text-tertiary)]`}>{ask.given.first ? t('chatArea.appEnable.devicesHint') : t('chatArea.appEnable.addsChat', { name: ask.given.chat.name })}</div> : null}
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" data-testid="extension-consent-cancel" onClick={() => answer('declined')}>
            {ask.cancelLabel ?? (ask.requester ? t('chatArea.appEnable.decline') : t('common.cancel'))}
          </Button>
          <Button data-testid="extension-consent-confirm" onClick={() => answer('confirmed')}>
            {ask.confirmLabel}
          </Button>
        </div>
      </div>
    </Sheet>
  )
}
