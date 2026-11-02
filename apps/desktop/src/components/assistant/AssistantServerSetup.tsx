import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import {
  AssistantServerSetupError,
  listAssistantServerTargets,
  pendingServerAssistant,
  resumeServerAssistant,
  setUpAssistantOnServer,
  type AssistantServerSetupProgress,
} from '../../lib/assistantServerSetup'
import type { AssistantSetupDraft } from '../../lib/assistantSetup'
import { offerCustomizeCard, writeSetupStep } from '../../lib/assistantSetupState'
import { reloadMyAssistant } from '../../lib/myAssistant'
import { rendererLogger } from '../../lib/log'
import { UI_EVENTS } from '../../lib/uiEvents'
import { requestAddServerOnOpen } from '../../lib/addServerIntent'
import { clearAssistantOnboardingNavigation } from '../../lib/assistantOnboardingNavigation'
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator'
import { Button } from '../ui/Button'

const log = rendererLogger('assistant/server-setup')

/** 只选择已添加的服务器；设备添加仍由设置页的既有流程负责。 */
export function AssistantServerSetup({ ownerUserId, name, createDraft, onBack, onAddServer }: {
  ownerUserId: string
  name: string
  createDraft: () => Promise<AssistantSetupDraft>
  onBack: () => void
  onAddServer?: () => void
}) {
  const { t } = useTranslation('assistant')
  const [pending, setPending] = useState(() => pendingServerAssistant(ownerUserId))
  const [selectedId, setSelectedId] = useState(pending?.deviceId ?? '')
  const [busy, setBusy] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [installing, setInstalling] = useState(pending?.installationStarted ?? false)
  const [progress, setProgress] = useState<AssistantServerSetupProgress | null>(null)
  const [failure, setFailure] = useState<unknown>(null)
  const attempt = useRef<AbortController | null>(null)
  const resumed = useRef(false)
  const targets = useQuery({
    queryKey: ['assistant-server-targets', ownerUserId],
    queryFn: listAssistantServerTargets,
    enabled: !pending && !busy,
    refetchOnMount: 'always',
  })
  const selected = targets.data?.find(target => target.deviceId === selectedId)
  const errorCode = failure instanceof AssistantServerSetupError ? failure.code : 'unknown'
  const fixedTarget = pending !== null || installing

  async function run(cancel = false) {
    if (attempt.current) return
    const controller = new AbortController()
    if (cancel) controller.abort()
    attempt.current = controller
    setBusy(true)
    setCancelling(cancel)
    setFailure(null)
    setProgress(null)
    try {
      const record = pendingServerAssistant(ownerUserId)
      const options = {
        signal: controller.signal,
        onInstalling: () => {
          clearAssistantOnboardingNavigation(ownerUserId)
          setInstalling(true)
          setPending(pendingServerAssistant(ownerUserId))
          writeSetupStep(ownerUserId, 'shell')
          offerCustomizeCard(ownerUserId)
        },
        onProgress: (state: AssistantServerSetupProgress) => setProgress(state),
      }
      if (record) await resumeServerAssistant(options)
      else {
        if (!selected?.selectable) return
        await setUpAssistantOnServer(await createDraft(), selected.deviceId, options)
      }
      writeSetupStep(ownerUserId, 'connect')
      reloadMyAssistant(ownerUserId)
    } catch (error) {
      const record = pendingServerAssistant(ownerUserId)
      setPending(record)
      setInstalling(record?.installationStarted ?? false)
      if (controller.signal.aborted && !record) { onBack(); return }
      setFailure(error)
      log.error({ error: String(error) }, 'server assistant setup failed')
    } finally {
      if (attempt.current === controller) attempt.current = null
      setBusy(false)
      setCancelling(false)
    }
  }

  useEffect(() => {
    let active = true
    // StrictMode's discarded mount must not start and immediately cancel the persisted operation.
    queueMicrotask(() => {
      if (!active || !pending || resumed.current) return
      resumed.current = true
      void run()
    })
    return () => { active = false; attempt.current?.abort() }
    // The persisted operation resumes once on entry; its draft and target belong to the helper.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function openDevices() {
    onAddServer?.()
    requestAddServerOnOpen()
    window.dispatchEvent(new CustomEvent(UI_EVENTS.openSettings, { detail: { section: 'devices' } }))
  }

  return <>
    <h1 className="ta-onb-title">{t('server.title')}</h1>
    <p className="ta-onb-sub">{t('server.note')}</p>
    {fixedTarget || busy ? <div className="ta-onb-field" data-testid="assistant-server-progress">
      <p className="ta-onb-choice-title">{pending?.deviceLabel ?? selected?.label}</p>
      {busy ? <p className="ta-onb-note inline-flex items-center gap-2" role="status">
        <LoadingIndicator size="inline" />{cancelling ? t('setup.cancelling') : progress ? t(`server.progress.${progress.phase}`) : t('server.resuming')}
      </p> : null}
    </div> : <div className="ta-onb-field">
      {targets.isPending ? <p className="ta-onb-note inline-flex items-center gap-2" role="status"><LoadingIndicator size="inline" />{t('server.loading')}</p>
        : targets.isError ? <>
          <p className="ta-onb-error" role="alert">{t('server.listFailed')}</p>
          <Button onClick={() => void targets.refetch()}>{t('setup.retry')}</Button>
        </> : <>
          {targets.data.length ? <div className="ta-onb-list ta-server-targets" aria-label={t('server.choose')}>
            {targets.data.map(target => <Button key={target.deviceId} variant="option" size="option" disabled={!target.selectable}
              aria-pressed={target.deviceId === selectedId} className="ta-server-target" onClick={() => setSelectedId(target.deviceId)} data-testid="assistant-server-target">
              <span className="ta-server-target-name">{target.label}</span>
              {!target.selectable && target.reason ? <span className="ta-onb-note">{t(`server.targetReason.${target.reason}`)}</span> : null}
            </Button>)}
          </div> : <p className="ta-onb-note" data-testid="assistant-server-empty">{t('server.empty')}</p>}
          <p className="ta-onb-note">{t('server.addNote')}</p>
          <div className="ta-onb-row">
            <Button onClick={openDevices} data-testid="assistant-server-add">{t('server.add')}</Button>
            <Button variant="ghost" disabled={targets.isFetching} onClick={() => void targets.refetch()}>{t('server.refresh')}</Button>
          </div>
        </>}
    </div>}
    {failure ? <p className="ta-onb-error" role="alert" data-testid="assistant-server-error">{t(`server.errors.${errorCode}`)}</p> : null}
    <div className="ta-onb-actions">
      {!busy && !fixedTarget ? <Button variant="secondary" className="rounded-full" onClick={onBack}>{t('setup.back')}</Button> : null}
      {!installing && progress?.cancellable ? <Button variant="secondary" className="rounded-full" disabled={cancelling}
        onClick={() => { if (busy) { setCancelling(true); attempt.current?.abort() } else void run(true) }}>{t(cancelling ? 'setup.cancelling' : 'setup.back')}</Button> : null}
      {failure && errorCode === 'assistant_exists' ? <Button onClick={() => reloadMyAssistant(ownerUserId)}>{t('server.openAssistant')}</Button>
        : !busy && (pending || targets.data?.some(target => target.selectable)) ? <Button variant="primary" className="rounded-full" disabled={!pending && (!selected?.selectable || targets.isError)}
          onClick={() => void run()} data-testid="assistant-server-install">{t(pending ? 'setup.retry' : 'server.install', { name })}</Button> : null}
    </div>
  </>
}
