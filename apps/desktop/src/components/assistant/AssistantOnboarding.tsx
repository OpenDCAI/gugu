import { messageForUser } from '@/lib/userFacingError';
import './assistant-onboarding.css'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation } from '@tanstack/react-query'
import { cloudComputerFailureKind, type CloudComputerSnapshot } from '@gugu/core/cloud/cloudComputer'
import type { Device } from '@gugu/core/shared/types/chat'
import { AgentAvatar } from '../agentAvatar/AgentAvatar'
import { Button } from '../ui/Button'
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator'
import { BODY_COLORS } from '../agentAvatar/engine/identity'
import {
  claimCloudAssistant,
  draftAvatarUrl,
  pendingLocalAssistant,
  resumeLocalAssistant,
  setUpAssistantOnThisComputer,
  AssistantSetupError,
  type AssistantSetupDraft,
} from '../../lib/assistantSetup'
import { offerCustomizeCard, writeSetupStep } from '../../lib/assistantSetupState'
import { AssistantSetupCleanupError } from '../../lib/assistantSetupPreparation'
import { readOccupation, takeAssistantStartAtHome } from '../../lib/firstRun'
import { AssistantIntro } from './AssistantIntro'
import { AssistantSetupIdentity } from './AssistantSetupIdentity'
import { DEFAULT_ASSISTANT_LOOK } from '../agentAvatar/look'
import { reloadMyAssistant } from '../../lib/myAssistant'
import { rendererLogger } from '../../lib/log'
import { getMembership } from '../../lib/billing/membership'
import { cloudComputerEnabled } from '@gugu/core/cloud/optionalServices'
import { refreshCloudComputer } from '../../lib/cloudComputerStore'
import { UI_EVENTS } from '../../lib/uiEvents'
import { CloudComputerProvisionPanel, CloudComputerRefusal, type CloudComputerActionFailure } from '../settings/CloudComputerSection'

const log = rendererLogger('assistant/onboarding')

type Step = 'intro' | 'name' | 'home'
type Busy = null | 'cloud' | 'computer' | 'resume'

/** 引导页根上的主题色相(一个数,见 assistant-today.css 的 --ta-tint-h)。 */
function tintStyle(hue: number): React.CSSProperties {
  return { '--ta-tint-h': hue } as React.CSSProperties
}

function openMembership() {
  window.dispatchEvent(new CustomEvent(UI_EVENTS.openSettings, { detail: { section: 'usage' } }))
}

/**
 * 开通咕咕的前半(product spec 开通那段,#7349,照 ChatGPT dots):「认识咕咕」→ 起名 → 住在哪 → 安家。
 * 名字在安家前确认；形象在安家前可自定义，未选择时为素色且不戴装扮。称呼与身份用账号上的那一份，开通时写进它的记忆。
 * 安好之后「连应用 → 它先开口」由会话页那一侧画(它要读它家那台的集成),这里只记「下一步是连应用」。
 * 从首次引导的「开通我的咕咕」进来 = 介绍已经看过,从起名开始(takeAssistantStartAtHome)。
 */
export function AssistantOnboarding({
  ownerUserId,
  ownerName,
  snapshot,
  device,
  cloudAvailable,
  localDeviceId,
}: {
  ownerUserId: string
  ownerName: string | null
  snapshot: CloudComputerSnapshot | null
  device: Device | null
  cloudAvailable: boolean
  /** 这台电脑的设备 id;网页 / 手机 = null(装不了它)。 */
  localDeviceId: string | null
}) {
  const { t } = useTranslation('assistant')
  const cloudEnabled = cloudComputerEnabled()
  const [step, setStep] = useState<Step>(() => (takeAssistantStartAtHome(ownerUserId) ? 'name' : 'intro'))
  const [draft, setDraft] = useState<AssistantSetupDraft>(() => ({
    // owner 10-16 夜:助理默认名就是「咕咕」(不再叫「个人助理」);人可以改成别的
    name: t('setup.defaultName'),
    ...DEFAULT_ASSISTANT_LOOK,
    owner: { preferredName: ownerName?.trim() ?? '', about: '' },
  }))
  const { t: tMain } = useTranslation('main')
  /** 开通时交给它的「关于主人」:称呼 + 身份,都读账号上的那一份。读不到身份 = 开通失败如实说,❌ 缺一格悄悄开通。 */
  const setupDraft = useCallback(async (): Promise<AssistantSetupDraft> => {
    const occupation = await readOccupation(ownerUserId)
    const label = occupation ? (occupation.key === 'other' ? occupation.text : tMain(`firstRun.occupation.${occupation.key}`)) : ''
    return { ...draft, owner: { preferredName: ownerName?.trim() ?? '', about: label ? t('setup.ownerOccupation', { occupation: label }) : '' } }
  }, [draft, ownerName, ownerUserId, t, tMain])
  const [busy, setBusy] = useState<Busy>(null)
  const localAttempt = useRef<AbortController | null>(null)
  const localInstallationStarted = useRef(false)
  const [installing, setInstalling] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [retryCleanup, setRetryCleanup] = useState<(() => Promise<void>) | null>(null)
  useEffect(() => () => localAttempt.current?.abort(), [])
  const [error, setError] = useState<string | null>(null)
  const [setupEnded, setSetupEnded] = useState(false)
  const [cloudFailure, setCloudFailure] = useState<CloudComputerActionFailure | null>(null)
  const [member, setMember] = useState<boolean | null>(null)
  const [memberError, setMemberError] = useState<string | null>(null)
  const [memberAttempt, setMemberAttempt] = useState(0)
  const hue = BODY_COLORS[draft.color]?.hue ?? 268
  const displayName = draft.name.trim() || t('setup.namePlaceholder')

  // 上次在这台电脑上建到一半(退出 / 断网):接着建同一个,❌ 再建一个。
  useEffect(() => {
    if (!localDeviceId) return
    let record
    try {
      record = pendingLocalAssistant(ownerUserId)
    } catch (e) {
      log.error({ error: String(e) }, 'read pending local assistant failed')
      return
    }
    if (!record) return
    let resumed = false
    localInstallationStarted.current = true
    setInstalling(true)
    setBusy('resume')
    writeSetupStep(ownerUserId, 'shell')
    resumeLocalAssistant(record)
      .then(() => { resumed = true; writeSetupStep(ownerUserId, 'connect'); reloadMyAssistant(ownerUserId) })
      .catch((e: unknown) => {
        writeSetupStep(ownerUserId, 'shell')
        setSetupEnded(e instanceof AssistantSetupError && e.kind === 'cancelled')
        setError(messageForUser(e))
        log.error({ error: String(e) }, 'resume local assistant failed')
      })
      .finally(() => setBusy(resumed ? null : 'computer'))
  }, [ownerUserId, localDeviceId])

  // 到「住哪」那一步才问会员档:没读到就当不是会员(云上那一条给「了解会员」,❌ 替人点一下领取)。
  useEffect(() => {
    if (!cloudEnabled || step !== 'home' || member !== null) return
    let cancelled = false
    setMemberError(null)
    getMembership()
      .then((m) => !cancelled && setMember(!!m && m.tier !== 'free'))
      .catch((e: unknown) => {
        log.error({ error: String(e) }, 'read membership failed')
        if (!cancelled) setMemberError(messageForUser(e))
      })
    return () => {
      cancelled = true
    }
  }, [cloudEnabled, step, member, memberAttempt])

  const claimCloud = useCallback(async () => {
    setBusy('cloud')
    setCloudFailure(null)
    writeSetupStep(ownerUserId, 'connect')
    // 「自定义」卡在人决定开通的这一刻就记下,❌ 等开通返回:开通可能等不到它起来就先返回「还在启动」,而它随后照样会起来
    // (见 lib/assistantSetupFinish)。卡只画在它的聊天里 —— 没开成就没有聊天,卡也就不会出现。
    offerCustomizeCard(ownerUserId)
    try {
      await claimCloudAssistant(await setupDraft())
    } catch (e) {
      writeSetupStep(ownerUserId, null)
      setCloudFailure({ kind: cloudComputerFailureKind(e) })
    } finally {
      setBusy(null)
    }
  }, [setupDraft, ownerUserId])

  const installHere = useCallback(async () => {
    if (!localDeviceId) return
    setBusy('computer')
    setInstalling(localInstallationStarted.current)
    setCancelling(false)
    const attempt = new AbortController()
    localAttempt.current = attempt
    setError(null)
    setSetupEnded(false)
    setRetryCleanup(null)
    let keepBusy = false
    try {
      const pending = pendingLocalAssistant(ownerUserId)
      // The write boundary belongs to this attempt. A failed previous commit
      // must not hide Back during a new, still reversible preparation.
      localInstallationStarted.current = !!pending
      setInstalling(!!pending)
      const onInstalling = () => {
        localInstallationStarted.current = true
        setInstalling(true)
        setCancelling(false)
        writeSetupStep(ownerUserId, 'shell')
        offerCustomizeCard(ownerUserId)
      }
      if (pending) {
        onInstalling()
        await resumeLocalAssistant(pending)
      } else await setUpAssistantOnThisComputer(await setupDraft(), localDeviceId, { signal: attempt.signal, onInstalling })
      writeSetupStep(ownerUserId, 'connect')
      reloadMyAssistant(ownerUserId)
    } catch (e) {
      keepBusy = localInstallationStarted.current || e instanceof AssistantSetupCleanupError
      writeSetupStep(ownerUserId, keepBusy ? 'shell' : null)
      setSetupEnded(e instanceof AssistantSetupError && e.kind === 'cancelled')
      if (e instanceof AssistantSetupCleanupError) setRetryCleanup(() => e.retry)
      if (!(e instanceof Error && e.name === 'AbortError')) {
        setError(messageForUser(e))
        log.error({ error: String(e) }, 'set up assistant on this computer failed')
      }
    } finally {
      if (localAttempt.current === attempt) localAttempt.current = null
      setCancelling(false)
      setBusy(keepBusy ? 'computer' : null)
    }
  }, [setupDraft, localDeviceId, ownerUserId])

  // 管家正在云上给它开家(会员一键领取之后,或上一次开到一半):进度由现成的开通面板说。
  if (cloudEnabled && (snapshot?.state === 'provisioning' || snapshot?.state === 'error')) {
    return (
      <div className="ta-onb-slot" data-ta-scope style={tintStyle(hue)}>
        <div className="ta-onb" data-testid="assistant-setup-cloud-progress">
          <AgentAvatar name={displayName} look={draft} id="assistant-draft" size={96} />
          {/* 标题由开通面板自己说(「正在准备你的助理」+ 三步),这里只放它的样子 */}
          <CloudComputerProvisionPanel
            snapshot={snapshot}
            device={device}
            onUpgrade={openMembership}
            // 开通就出错再重来时,带上引导里填的名字 / 形象 / 称呼(❌ 退回默认的「个人助理」)
            retryProvision={async () => claimCloudAssistant(await setupDraft())}
          />
        </div>
      </div>
    )
  }

  const working = busy === 'computer' || busy === 'resume'
  return (
    <div className="ta-onb-slot" data-ta-scope style={tintStyle(hue)}>
      <div className="ta-onb" data-testid={`assistant-setup-${step}`}>
        {working ? (
          <>
            <AgentAvatar name={displayName} look={draft} id="assistant-draft" size={96} />
            <h1 className="ta-onb-title">
              {busy === 'resume' ? t('setup.resuming', { name: displayName }) : t('setup.installing', { name: displayName })}
            </h1>
            {error && busy === 'computer' ? <>
              <p className="ta-onb-error" role="alert">{retryCleanup ? t('setup.cleanupFailed') : setupEnded ? t('setup.ended') : error}</p>
              <Button onClick={async () => {
                if (retryCleanup) {
                  setCancelling(true)
                  try {
                    await retryCleanup()
                    setRetryCleanup(null)
                    if (!localInstallationStarted.current) { setError(null); setBusy(null); return }
                  } catch (e) { log.error({ error: String(e) }, 'assistant preparation cleanup retry failed'); return }
                  finally { setCancelling(false) }
                }
                void installHere()
              }} disabled={cancelling}>{t(setupEnded ? 'setup.startNew' : 'setup.retry')}</Button>
            </> : <p className="ta-onb-sub inline-flex items-center gap-2">
              <LoadingIndicator size="inline" />
              {t('setup.installingBody')}
            </p>}
            {busy === 'computer' && !installing && !error ? <Button variant="secondary" className="rounded-full" disabled={cancelling}
              onClick={() => { setCancelling(true); localAttempt.current?.abort() }} data-testid="assistant-setup-return">
              {cancelling ? t('setup.cancelling') : t('setup.back')}
            </Button> : null}
          </>
        ) : step === 'intro' ? (
          <AssistantIntro primaryLabel={t('setup.introStart')} onPrimary={() => setStep('name')} look={draft} />
        ) : step === 'name' ? (
          <AssistantSetupIdentity draft={draft} onChange={setDraft} onBack={() => setStep('intro')} onContinue={() => setStep('home')} />
        ) : memberError ? (
          <>
            <p className="ta-onb-error" role="alert">{memberError}</p>
            <Button onClick={() => setMemberAttempt((attempt) => attempt + 1)}>{t('setup.retry')}</Button>
          </>
        ) : (
          <HomeChoice
            name={displayName}
            member={cloudEnabled ? member : false}
            cloudEnabled={cloudEnabled}
            cloudAvailable={cloudAvailable}
            canHostHere={!!localDeviceId}
            busy={busy}
            error={error}
            cloudFailure={cloudFailure}
            onCloud={() => void claimCloud()}
            onComputer={() => void installHere()}
            onBack={() => setStep('name')}
            draftAvatar={draftAvatarUrl(draft)}
          />
        )}
      </div>
    </div>
  )
}

function HomeChoice({
  name,
  member,
  cloudEnabled,
  cloudAvailable,
  canHostHere,
  busy,
  error,
  cloudFailure,
  onCloud,
  onComputer,
  onBack,
  draftAvatar,
}: {
  name: string
  member: boolean | null
  cloudEnabled: boolean
  cloudAvailable: boolean
  canHostHere: boolean
  busy: Busy
  error: string | null
  cloudFailure: CloudComputerActionFailure | null
  onCloud: () => void
  onComputer: () => void
  onBack: () => void
  draftAvatar: string
}) {
  const { t } = useTranslation('assistant')
  const { t: tc } = useTranslation('common')
  const cloudCheck = useMutation({ mutationFn: refreshCloudComputer })
  if (member === null) {
    return (
      <p className="ta-onb-sub inline-flex items-center gap-2" data-testid="assistant-setup-home-loading">
        <LoadingIndicator size="inline" />
        {t('cloud.loading')}
      </p>
    )
  }
  const cloud = cloudEnabled ? (
    <div className="ta-onb-choice" data-recommended={member && cloudAvailable} data-testid="assistant-setup-home-cloud">
      <span className="ta-onb-choice-title">{t('setup.homeCloudTitle')}</span>
      <span className="ta-onb-choice-body">{t('setup.homeCloudBody')}</span>
      <div className="ta-onb-choice-actions">
        {!cloudAvailable ? (
          <>
            {!cloudCheck.error && <span className="ta-onb-note" role="status">{t(cloudCheck.isSuccess ? 'setup.cloudStillUnavailable' : 'setup.cloudNotOpen')}</span>}
            {canHostHere && <span className="ta-onb-note">{t('setup.chooseComputer')}</span>}
            <Button variant="secondary" className="rounded-full" disabled={busy !== null || cloudCheck.isPending} onClick={() => cloudCheck.mutate()}>
              {cloudCheck.isPending ? <><LoadingIndicator size="inline" />{t('cloud.loading')}</> : t('setup.retry')}
            </Button>
          </>
        ) : member ? (
          <Button variant="primary" size="lg" className="rounded-full" disabled={busy !== null} onClick={onCloud} data-testid="assistant-setup-claim-cloud">
            {t('setup.homeCloudAction')}
          </Button>
        ) : (
          <>
            <span className="ta-onb-note">{t('setup.homeCloudNeedsMember')}</span>
            <Button variant="secondary" className="rounded-full" onClick={openMembership} data-testid="assistant-setup-member">
              {t('setup.memberLink')}
            </Button>
          </>
        )}
      </div>
    </div>
  ) : null
  const computer = canHostHere ? (
    <div className="ta-onb-choice" data-recommended={!member || !cloudAvailable} data-testid="assistant-setup-home-computer">
      <span className="ta-onb-choice-title">{t('setup.homeComputerTitle')}</span>
      <span className="ta-onb-choice-body">{t('setup.homeComputerBody')}</span>
      <div className="ta-onb-choice-actions">
        <Button variant="primary" size="lg" className="rounded-full" disabled={busy !== null} onClick={onComputer} data-testid="assistant-setup-install-here">
          {t('setup.homeComputerAction')}
        </Button>
      </div>
    </div>
  ) : (
    <div className="ta-onb-choice" data-testid="assistant-setup-home-nocomputer">
      <span className="ta-onb-choice-title">{t('setup.homeNoComputerTitle')}</span>
      <span className="ta-onb-choice-body">{t('setup.homeNoComputerBody')}</span>
    </div>
  )
  return (
    <>
      <AgentAvatar name={name} avatar={draftAvatar} id="assistant-draft" size={72} />
      <h1 className="ta-onb-title">{t('setup.homeTitle', { name })}</h1>
      <div className="ta-onb-choices">
        {member && cloudAvailable ? (
          <>
            {cloud}
            {computer}
          </>
        ) : (
          <>
            {computer}
            {cloud}
          </>
        )}
      </div>
      {cloudCheck.error && <p className="ta-onb-error" role="alert">{tc(`cloudComputer.reason.${cloudComputerFailureKind(cloudCheck.error)}`)}</p>}
      {error ? (
        <p className="ta-onb-error" role="alert" data-testid="assistant-setup-error">
          {error}
        </p>
      ) : null}
      {cloudFailure ? <CloudComputerRefusal failure={cloudFailure} prefixKey="devices.cloud.provisionFailed" onUpgrade={openMembership} /> : null}
      <div className="ta-onb-actions">
        <Button variant="secondary" size="lg" className="rounded-full" onClick={onBack}>
          {t('setup.back')}
        </Button>
      </div>
    </>
  )
}
