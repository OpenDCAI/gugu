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
import { finishFirstRun, firstRunDoneHere, readFirstRunProgress, rememberFirstRunDone, requestAssistantSetupHandoff, writeOccupation } from '../../lib/firstRun'
import { useAuth, type AuthUser } from '../../store/auth'
import { rendererLogger } from '../../lib/log'
import '../../i18n/registerMainCatalog'
import { PhoneAgentSetupGate } from '../../mobile/local-agent/PhoneAgentSetupGate'
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClient } from '@renderer/lib/query-client'
import { platform } from '../../platform'
import { ProductTour } from '../productTour/ProductTour'
import { FirstRunHarness } from './FirstRunHarness'
import { FirstRunInstallProvider } from './FirstRunInstallProvider'
import { UI_EVENTS } from '../../lib/uiEvents'
import { startFirstRunHints } from '../../lib/firstRunHints'
import { FirstRunHints } from './FirstRunHints'

const log = rendererLogger('first-run')

type GateState =
  | { kind: 'loading' }
  | { kind: 'unreadable'; message: string }
  | { kind: 'profile'; occupation: Occupation | null }
  | { kind: 'intro' }
  | { kind: 'harness' }
  | { kind: 'tour' }
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

  // ❌ 等 identityPending 落定再读:身份行在注册那一刻就在(auth.users 的插入触发器),pending 只是「客户端还没补全」;
  // 补全一直落不了地时,等它 = 门口永远转圈,而主界面本来照样能用。补全晚到的称呼 / 头像由 FirstRunProfile 跟上。
  const load = useCallback(() => {
    if (firstRunDoneHere(user.id)) return
    setState({ kind: 'loading' })
    readFirstRunProgress(user.id)
      .then((progress) => {
        if (progress.stage === 'done') done()
        else if (progress.stage === 'intro') setState(platform.kind === 'electron' && !progress.harness ? { kind: 'harness' } : { kind: 'intro' })
        else setState({ kind: 'profile', occupation: progress.occupation })
      })
      .catch((e: unknown) => {
        log.error({ error: String(e) }, 'read first-run progress failed')
        setState({ kind: 'unreadable', message: messageForUser(e) })
      })
  }, [user.id, done])

  useEffect(load, [load])

  useEffect(() => {
    if (platform.kind !== 'electron') return
    const reopen = () => setState({ kind: 'tour' })
    window.addEventListener(UI_EVENTS.reopenProductTour, reopen)
    return () => window.removeEventListener(UI_EVENTS.reopenProductTour, reopen)
  }, [])

  // The embedded task entry bootstraps once per document; finishing or reopening the tour must
  // keep its product tree and mount element connected at the same position.
  if (state.kind === 'done' || state.kind === 'tour' || (state.kind === 'intro' && platform.kind === 'electron')) return (
    <PhoneAgentSetupGate key={user.id} ownerId={user.id}>
      <div className="contents" inert={state.kind === 'intro'}>{children}</div>
      {state.kind === 'done' && <FirstRunHints key={user.id} userId={user.id} />}
      {state.kind === 'intro' && <div className="ta-first-run ta-first-run-overlay" data-ta-scope data-testid="first-run-intro"><div className="ta-onb"><FirstRunIntro userId={user.id} onDone={done} /></div></div>}
      {state.kind === 'tour' && <ProductTour key={user.id} userId={user.id} onDone={done} />}
    </PhoneAgentSetupGate>
  )

  if (state.kind === 'loading') return <FullScreenLoader />
  return (
    <div className="ta-first-run" data-ta-scope data-testid={`first-run-${state.kind}`}>
      <div className={`ta-onb${state.kind === 'harness' ? ' first-run-harness-panel' : ''}`}>
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
          <FirstRunProfile user={user} initial={state.occupation} onDone={() => setState({ kind: platform.kind === 'electron' ? 'harness' : 'intro' })} />
        ) : state.kind === 'harness' ? (
          <FirstRunHarness userId={user.id} onDone={() => setState({ kind: 'intro' })} />
        ) : (
          <FirstRunIntro userId={user.id} onDone={done} />
        )}
      </div>
    </div>
  )
}

function FirstRunProfile({ user, initial, onDone }: { user: AuthUser; initial: Occupation | null; onDone: () => void }) {
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

function FirstRunIntro({ userId, onDone }: { userId: string; onDone: () => void }) {
  const { t } = useTranslation('main')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const leave = async (openAssistant: boolean, openTour = false) => {
    setBusy(true)
    setError(null)
    try {
      await startFirstRunHints(userId)
      await finishFirstRun()
      if (openAssistant) requestAssistantSetupHandoff(userId)
      onDone()
      // FirstRunFlow is still mounted and listens for this; the tour closes into the main screen.
      if (openTour) window.dispatchEvent(new CustomEvent(UI_EVENTS.reopenProductTour))
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
      tourLabel={platform.kind === 'electron' ? t('firstRun.introTour') : undefined}
      onTour={() => void leave(false, true)}
      busy={busy}
      error={error}
    />
  )
}
