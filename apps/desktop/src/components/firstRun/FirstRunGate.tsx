import { messageForUser } from '@/lib/userFacingError';
import '../assistant/assistant-onboarding.css'
import '../../session/renderer/features/assistant/assistant-today.css'
import { useCallback, useEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { OCCUPATION_KEYS, OCCUPATION_OTHER_MAX, occupationComplete, type Occupation } from '@gugu/core/shared/firstRun'
import { Avatar } from '../Avatar'
import { Button } from '../ui/Button'
import { FullScreenLoader } from '../FullScreenLoader'
import { AssistantIntro } from '../assistant/AssistantIntro'
import { Pencil } from '@/lib/icons'
import { authService } from '../../lib/auth'
import { finishFirstRun, firstRunDoneHere, readFirstRunProgress, readOccupation, rememberFirstRunDone, requestAssistantSetupHandoff, writeOccupation } from '../../lib/firstRun'
import { useAuth, type AuthUser } from '../../store/auth'
import { rendererLogger } from '../../lib/log'
import '../../i18n/registerMainCatalog'
import { PhoneAgentSetupGate } from '../../mobile/local-agent/PhoneAgentSetupGate'
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClient } from '@renderer/lib/query-client'
import { platform } from '../../platform'
import { ProductTour } from '../productTour/ProductTour'
import { availableTourSteps } from '../productTour/tourTargets'
import { FeatureFilms } from '../productTour/FeatureFilms'
import type { ProductTourRequest, TourStepId } from '../../lib/productTour'
import { FirstRunHarness } from './FirstRunHarness'
import { FirstRunTerminal } from './FirstRunTerminal'
import { FirstRunInstallProvider } from './FirstRunInstallProvider'
import { UI_EVENTS } from '../../lib/uiEvents'
import { startFirstRunHints } from '../../lib/firstRunHints'
import { FirstRunHints } from './FirstRunHints'

const log = rendererLogger('first-run')

// 全屏步骤的顺序(规范 4.1):每页顶上写「n / N」,N 只数这台设备真会走的页。
type StepKind = 'profile' | 'harness' | 'terminal' | 'intro' | 'tourChoice'
// 桌面端最后一页问一次要不要看功能栏导览(规范 4.1 第 5 步:由人自己选择开始);导览只有桌面端有。
const STEPS: readonly StepKind[] = platform.kind === 'electron' ? ['profile', 'harness', 'terminal', 'intro', 'tourChoice'] : ['profile', 'intro']
function StepCount({ step }: { step: StepKind }) {
  const { t } = useTranslation('main')
  return <p className="first-run-step-count" data-testid="first-run-step-count">{t('firstRun.stepCount', { current: STEPS.indexOf(step) + 1, total: STEPS.length })}</p>
}

type GateState =
  | { kind: 'loading' }
  | { kind: 'unreadable'; message: string }
  | { kind: 'profile'; occupation: Occupation | null }
  | { kind: 'intro' }
  | { kind: 'harness' }
  | { kind: 'terminal' }
  | { kind: 'tourChoice'; openAssistant: boolean }
  | { kind: 'tour'; steps: readonly TourStepId[]; start: TourStepId }
  | { kind: 'films' }
  | { kind: 'done' }

/**
 * 新账号的第一次打开(product spec,#7348):登录之后、主界面之前。
 * 走完(或老账号)= 直接画 children;读不到进度 = 如实说 + 重试,❌ 当新账号重走,❌ 当走完放行。
 */
export function FirstRunGate(props: { user: AuthUser; children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      {platform.kind === 'electron'
        ? <FirstRunInstallProvider><FirstRunFlow {...props} /></FirstRunInstallProvider>
        : <FirstRunFlow {...props} />}
    </QueryClientProvider>
  )
}

function FirstRunFlow({ user, children }: { user: AuthUser; children: ReactNode }) {
  const { t } = useTranslation('main')
  const [state, setState] = useState<GateState>(() => firstRunDoneHere(user.id) ? { kind: 'done' } : { kind: 'loading' })
  const done = useCallback(() => { rememberFirstRunDone(user.id); setState({ kind: 'done' }) }, [user.id])
  // 退回上一页时「已填的内容还在」(规范 7-2):选过的 Agent 记在这里,称呼和身份由 FirstRunProfile 从账号读回。
  const harnessPicked = useRef<readonly string[] | null>(null)
  const backToProfile = useCallback(() => {
    setState({ kind: 'loading' })
    readOccupation(user.id)
      .then((occupation) => setState({ kind: 'profile', occupation }))
      .catch((e: unknown) => setState({ kind: 'unreadable', message: messageForUser(e) }))
  }, [user.id])

  // ❌ 等 identityPending 落定再读:身份行在注册那一刻就在(auth.users 的插入触发器),pending 只是「客户端还没补全」;
  // 补全一直落不了地时,等它 = 门口永远转圈,而主界面本来照样能用。补全晚到的称呼 / 头像由 FirstRunProfile 跟上。
  const load = useCallback(() => {
    if (firstRunDoneHere(user.id)) return
    setState({ kind: 'loading' })
    readFirstRunProgress(user.id)
      .then((progress) => {
        if (progress.stage === 'done') done()
        else if (progress.stage === 'intro') {
          harnessPicked.current = progress.harness
          if (platform.kind !== 'electron') setState({ kind: 'intro' })
          else setState(!progress.harness ? { kind: 'harness' } : !progress.terminalSeen ? { kind: 'terminal' } : { kind: 'intro' })
        }
        else setState({ kind: 'profile', occupation: progress.occupation })
      })
      .catch((e: unknown) => {
        log.error({ error: String(e) }, 'read first-run progress failed')
        setState({ kind: 'unreadable', message: messageForUser(e) })
      })
  }, [user.id, done])

  useEffect(load, [load])

  const startTour = useCallback((from: TourStepId | null) => {
    const steps = availableTourSteps()
    // 一格都找不到(功能栏没画出来):不弹指向空白的卡片(规范 2.3),直接进主界面。
    if (!steps.length) { setState({ kind: 'done' }); return }
    setState({ kind: 'tour', steps, start: from && steps.includes(from) ? from : steps[0] })
  }, [])
  // 「帮助与导览」(规范 4.3):从第 n 步继续、从头开始、看功能短片。老账号也只从这里看,❌ 自动重放。
  useEffect(() => {
    if (platform.kind !== 'electron') return
    const reopen = (event: Event) => {
      const detail = (event as CustomEvent<ProductTourRequest | undefined>).detail
      if (detail?.mode === 'films') setState({ kind: 'films' })
      else startTour(detail?.mode === 'resume' ? detail.step : null)
    }
    window.addEventListener(UI_EVENTS.reopenProductTour, reopen)
    return () => window.removeEventListener(UI_EVENTS.reopenProductTour, reopen)
  }, [startTour])

  // The embedded task entry bootstraps once per document; finishing or reopening the tour must
  // keep its product tree and mount element connected at the same position.
  const overlay = state.kind === 'intro' || state.kind === 'tourChoice'
  if (state.kind === 'done' || state.kind === 'tour' || state.kind === 'films' || (overlay && platform.kind === 'electron')) return (
    <PhoneAgentSetupGate key={user.id} ownerId={user.id}>
      <div className="contents" inert={overlay}>{children}</div>
      {state.kind === 'done' && <FirstRunHints key={user.id} userId={user.id} />}
      {state.kind === 'intro' && <div className="ta-first-run ta-first-run-overlay" data-ta-scope data-testid="first-run-intro"><div className="ta-onb"><StepCount step="intro" /><FirstRunIntro userId={user.id} onDone={done} onBack={() => setState({ kind: 'terminal' })} onNext={(openAssistant) => setState({ kind: 'tourChoice', openAssistant })} /></div></div>}
      {state.kind === 'tourChoice' && <div className="ta-first-run ta-first-run-overlay" data-ta-scope data-testid="first-run-tour-choice"><div className="ta-onb"><StepCount step="tourChoice" />
        <FirstRunTourChoice userId={user.id} openAssistant={state.openAssistant} onBack={() => setState({ kind: 'intro' })}
          onDone={(tour) => { rememberFirstRunDone(user.id); if (tour) startTour(null); else setState({ kind: 'done' }) }} /></div></div>}
      {state.kind === 'tour' && <ProductTour key={user.id} userId={user.id} steps={state.steps} start={state.start} onDone={done} />}
      {state.kind === 'films' && <FeatureFilms onClose={done} />}
    </PhoneAgentSetupGate>
  )

  if (state.kind === 'loading') return <FullScreenLoader />
  return (
    <div className="ta-first-run" data-ta-scope data-testid={`first-run-${state.kind}`}>
      <div className={`ta-onb${state.kind === 'harness' ? ' first-run-harness-panel' : state.kind === 'terminal' ? ' first-run-terminal-panel' : ''}`}>
        {state.kind === 'unreadable' ? (
          <>
            <h1 className="ta-onb-title">{t('firstRun.unreadableTitle')}</h1>
            <p className="ta-onb-sub">{state.message}</p>
            <div className="ta-onb-actions">
              <Button variant="primary" size="lg" className="rounded-full" onClick={load} data-testid="first-run-retry">
                {t('firstRun.retry')}
              </Button>
            </div>
          </>
        ) : state.kind === 'profile' ? (
          <FirstRunProfile step={<StepCount step="profile" />} user={user} initial={state.occupation} onDone={() => setState({ kind: platform.kind === 'electron' ? 'harness' : 'intro' })} />
        ) : state.kind === 'harness' ? (
          <>
            <StepCount step="harness" />
            <FirstRunHarness userId={user.id} initial={harnessPicked.current} onBack={backToProfile}
              onDone={(selected) => { harnessPicked.current = selected; setState({ kind: 'terminal' }) }} />
          </>
        ) : state.kind === 'terminal' ? (
          // 选完 Agent、认识咕咕之前(owner 10-27)。开关即时写本机设置;「继续」记下看过这一页,中途退出再进回到这里。
          <>
            <StepCount step="terminal" />
            <FirstRunTerminal userId={user.id} onBack={() => setState({ kind: 'harness' })} onDone={() => setState({ kind: 'intro' })} />
          </>
        ) : (
          <>
            <StepCount step="intro" />
            <FirstRunIntro userId={user.id} onDone={done} onBack={backToProfile} />
          </>
        )}
      </div>
    </div>
  )
}

function FirstRunProfile({ user, initial, step, onDone }: { user: AuthUser; initial: Occupation | null; step: ReactNode; onDone: () => void }) {
  const { t } = useTranslation('main')
  const { updateUser } = useAuth()
  const [name, setName] = useState(user.nickname)
  const [occupation, setOccupation] = useState<Occupation | null>(initial)
  const [otherText, setOtherText] = useState(initial?.key === 'other' ? initial.text : '')
  const [avatarUrl, setAvatarUrl] = useState(user.avatarUrl)
  const [busy, setBusy] = useState<null | 'avatar' | 'save'>(null)
  const [error, setError] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const nameEdited = useRef(false)

  // 身份补全晚到(登录后才落地):人还没动过的称呼、还没有的头像跟上补全后的值;人改过的 ❌ 被覆盖。
  useEffect(() => {
    if (!nameEdited.current) setName(user.nickname)
  }, [user.nickname])
  useEffect(() => {
    setAvatarUrl((current) => current ?? user.avatarUrl)
  }, [user.avatarUrl])

  const chosen: Occupation | null = occupation?.key === 'other' ? { key: 'other', text: otherText } : occupation
  const canContinue = name.trim().length > 0 && occupationComplete(chosen) && busy === null

  const pickAvatar = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setBusy('avatar')
    setError(null)
    const res = await authService.updateAvatar(user.id, file)
    setBusy(null)
    if (!res.success || !res.avatarUrl) {
      setError(res.error ?? t('firstRun.saveFailed'))
      return
    }
    setAvatarUrl(res.avatarUrl)
    updateUser({ ...user, avatarUrl: res.avatarUrl })
  }

  const submit = async () => {
    if (!canContinue || !chosen) return
    setBusy('save')
    setError(null)
    try {
      const trimmed = name.trim()
      if (trimmed !== user.nickname) {
        const res = await authService.updateNickname(user.id, trimmed)
        if (!res.success) throw new Error(res.error ?? t('firstRun.saveFailed'))
        updateUser({ ...user, nickname: trimmed, avatarUrl })
      }
      await writeOccupation(user.id, chosen)
      onDone()
    } catch (e) {
      log.error({ error: String(e) }, 'save first-run profile failed')
      setError(messageForUser(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      {step}
      <Avatar name={name || user.nickname} avatarUrl={avatarUrl} seed={user.id} size={88} />
      <Button
        variant="secondary"
        size="sm"
        className="rounded-full"
        onClick={() => fileInput.current?.click()}
        disabled={busy !== null}
        data-testid="first-run-avatar"
      >
        <Pencil size={14} aria-hidden />
        {busy === 'avatar' ? t('firstRun.avatarUploading') : t('firstRun.avatar')}
      </Button>
      <input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => void pickAvatar(e)} />
      <h1 className="ta-onb-title">{t('firstRun.profileTitle')}</h1>
      <p className="ta-onb-sub">{t('firstRun.profileSub')}</p>
      <label className="ta-onb-field">
        <span className="ta-field-label">{t('firstRun.nameLabel')}</span>
        <input
          className="ta-input"
          value={name}
          maxLength={40}
          onChange={(e) => {
            nameEdited.current = true
            setName(e.target.value)
          }}
          placeholder={t('firstRun.namePlaceholder')}
          data-testid="first-run-name"
        />
      </label>
      <div className="ta-onb-field">
        <span className="ta-field-label" id="first-run-occupation-label">{t('firstRun.occupationLabel')}</span>
        <div className="ta-onb-chips" role="radiogroup" aria-labelledby="first-run-occupation-label">
          {[...OCCUPATION_KEYS, 'other' as const].map((key) => (
            <Button
              key={key}
              variant="option"
              size="sm"
              role="radio"
              aria-checked={occupation?.key === key}
              className="rounded-full"
              onClick={() => setOccupation(key === 'other' ? { key: 'other', text: otherText } : { key })}
              data-testid={`first-run-occupation-${key}`}
            >
              {t(`firstRun.occupation.${key}`)}
            </Button>
          ))}
        </div>
        {occupation?.key === 'other' ? (
          <input
            className="ta-input"
            value={otherText}
            maxLength={OCCUPATION_OTHER_MAX}
            autoFocus
            onChange={(e) => setOtherText(e.target.value)}
            placeholder={t('firstRun.otherPlaceholder')}
            data-testid="first-run-occupation-other-text"
          />
        ) : null}
      </div>
      {error ? <p className="ta-onb-error" role="alert">{error}</p> : null}
      <div className="ta-onb-actions ta-onb-actions-stack">
        <Button
          variant="primary"
          size="lg"
          className="rounded-full ta-onb-primary"
          disabled={!canContinue}
          onClick={() => void submit()}
          data-testid="first-run-profile-continue"
        >
          {busy === 'save' ? t('firstRun.saving') : t('firstRun.continue')}
        </Button>
      </div>
    </>
  )
}

/**
 * 认识咕咕之后,桌面端最后一页(规范 4.1 第 5 步):问一次要不要看功能栏导览。一句话,两个选择。
 * 两个都算走完首次引导(记在账号上);「开通我的咕咕」的交接照旧,导览盖在咕咕那一格上面从第 1 步走。
 */
function FirstRunTourChoice({ userId, openAssistant, onBack, onDone }: { userId: string; openAssistant: boolean; onBack: () => void; onDone: (tour: boolean) => void }) {
  const { t } = useTranslation('main')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const leave = async (tour: boolean) => {
    setBusy(true)
    setError(null)
    try {
      await startFirstRunHints(userId)
      await finishFirstRun()
      if (openAssistant) requestAssistantSetupHandoff(userId)
      onDone(tour)
    } catch (e) {
      log.error({ error: String(e) }, 'finish first run failed')
      setError(messageForUser(e))
      setBusy(false)
    }
  }
  return (
    <>
      <h1 className="ta-onb-title">{t('firstRun.tourChoiceTitle')}</h1>
      <p className="ta-onb-sub">{t('firstRun.tourChoiceSub')}</p>
      {error ? <p className="ta-onb-error" role="alert">{error}</p> : null}
      <div className="ta-onb-actions ta-onb-actions-stack">
        <Button variant="primary" size="lg" className="rounded-full ta-onb-primary" onClick={() => void leave(true)} disabled={busy} data-testid="first-run-tour-start">{t('firstRun.tourChoiceStart')}</Button>
        <div className="flex items-center justify-center self-center">
          <Button variant="ghost" size="sm" className="rounded-full" onClick={onBack} disabled={busy} data-testid="first-run-tour-back">{t('firstRun.back')}</Button>
          <Button variant="ghost" size="sm" className="rounded-full" onClick={() => void leave(false)} disabled={busy} data-testid="first-run-tour-skip">{t('firstRun.tourChoiceSkip')}</Button>
        </div>
      </div>
    </>
  )
}

function FirstRunIntro({ userId, onDone, onBack, onNext }: { userId: string; onDone: () => void; onBack: () => void; onNext?: (openAssistant: boolean) => void }) {
  const { t } = useTranslation('main')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const leave = async (openAssistant: boolean) => {
    // 桌面端后面还有一页(问要不要看导览):走完记在那一页。
    if (onNext) { onNext(openAssistant); return }
    setBusy(true)
    setError(null)
    try {
      await startFirstRunHints(userId)
      await finishFirstRun()
      if (openAssistant) requestAssistantSetupHandoff(userId)
      onDone()
    } catch (e) {
      log.error({ error: String(e) }, 'finish first run failed')
      setError(messageForUser(e))
      setBusy(false)
    }
  }

  return (
    <AssistantIntro
      primaryLabel={t('firstRun.introStart')}
      onPrimary={() => void leave(true)}
      laterLabel={t('firstRun.introLater')}
      onLater={() => void leave(false)}
      backLabel={t('firstRun.back')}
      onBack={onBack}
      busy={busy}
      error={error}
    />
  )
}
