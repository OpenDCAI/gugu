import { observer } from 'mobx-react-lite'
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import '../../i18n/registerBrowserUseCatalog'
import './browserUse.css'
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator'
import { Check, Globe, KeyRound, RefreshCw, Square, X } from '@/lib/icons'
import { canOpenLiveBrowser } from '@/lib/browserUseLink'
import type { CloudBrowserServerMessage, CloudBrowserTab } from '@/session/shared/cloud-browser'
import { Button } from '../ui/Button'
import { IconButton } from '../ui/IconButton'
import { Sheet } from '../ui/Sheet'
import { cloudBrowserLine, siteLabel, type CloudBrowserLine } from './browserUseLabels'
import { BrowserUseScreen } from './BrowserUseScreen'
import { chunkText, nextTextId } from './screenMath'
import { BrowserUseVault, type VaultOutcome } from './BrowserUseVault'
import { browserUseMachine, openTaskBrowser } from './browserUsePlace'
import { useBrowserUse, type BrowserUseView } from './useBrowserUse'

/**
 * Browser Use App 的「浏览器」页签(manifest `hostPage: 'browser'`,每任务一份;owner 10-28 起看 / 接管 agent 浏览器的唯一地方)。
 * 宿主画,❌ 加载 App 的 HTML。画的是页签所属那个任务的浏览器:
 *   · 任务在这台电脑上:agent 用的就是任务自带的「浏览器」页签 —— 一句话加一个按钮指过去,❌ 再画一份画面;
 *   · 任务在另一台咕咕桌面上:如实说在那台电脑上;
 *   · 任务在咕咕 server 上:那台机器上的 Chrome —— 实时画面、标签页、接管 / 交还、停止 / 允许继续,
 *     agent 请人登录这个任务要登的网站时弹密码保险箱。
 * `sessionId` = 页属于的任务(常驻页的地方 `session:<id>`);null = 不在任务里。`active` = 此刻有一格在屏上认领它。
 */
export const BrowserUseHostPage = observer(function BrowserUseHostPage({ sessionId, active }: { sessionId: string | null; active: boolean }) {
  const { t } = useTranslation('browserUse')
  if (!sessionId) return <Empty>{t('place.noTask')}</Empty>
  const machine = browserUseMachine(sessionId)
  if (machine.kind === 'local') {
    return (
      <Empty>
        <p>{t('place.local')}</p>
        <Button variant="primary" size="sm" data-testid="browser-use-open-local" onClick={() => openTaskBrowser(sessionId)}>
          <Globe size={14} /> {t('place.openLocal')}
        </Button>
      </Empty>
    )
  }
  if (machine.kind === 'desktop') return <Empty>{t('place.otherDesktop', { machine: machine.label })}</Empty>
  if (!machine.online) return <Empty>{t('place.offline', { machine: machine.label })}</Empty>
  return <ServerBrowser key={machine.deviceId} deviceId={machine.deviceId} machineLabel={machine.label} sessionId={sessionId} active={active} direct={machine.direct} />
})

function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="bu-empty" data-testid="browser-use-empty">
      {typeof children === 'string' ? <p>{children}</p> : children}
    </div>
  )
}

function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || document.visibilityState === 'visible')
  useEffect(() => {
    const sync = () => setVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', sync)
    return () => document.removeEventListener('visibilitychange', sync)
  }, [])
  return visible
}

function lineText(line: CloudBrowserLine, t: TFunction<'browserUse'>): string {
  if (line.key !== 'needs') return t(line.key)
  const what =
    line.assistance.text ??
    (line.assistance.kind === 'login' ? t('vault.login', { site: siteLabel(line.assistance.site) }) : t('viewer.requestTakeover'))
  return `${t('viewer.needsUserAction')} · ${what}`
}

type Controls = {
  view: BrowserUseView
  line: CloudBrowserLine
  releasing: boolean
  takeControl: () => void
  release: () => void
  askStop: () => void
  resume: () => void
  openVault: () => void
}

function useControls(view: BrowserUseView, everOpened: boolean, active: boolean) {
  const [releasing, setReleasing] = useState(false)
  // 开的是哪一次请求的保险箱:那次请求结束(填好 / 超时 / 被关掉)它就不算开着。
  const [vaultFor, setVaultFor] = useState<string | null>(null)
  const askId = view.assistance?.kind === 'login' ? view.assistance.requestId : null
  const vaultOpen = !!askId && vaultFor === askId
  const setVaultOpen = useCallback((open: boolean) => setVaultFor(open ? askId : null), [askId])
  // 这个任务请人登录:页签在屏上(从任务卡上点「在 Browser Use 里登录」过来,或本来就开着)就把保险箱递到人面前,
  // 每次请求一回;关掉了还能点「登录 某站」再开。
  const offered = useRef<string | null>(null)
  useEffect(() => {
    if (!askId || !active || !view.live || offered.current === askId) return
    offered.current = askId
    setVaultFor(askId)
  }, [askId, active, view.live])
  const [stopAsked, setStopAsked] = useState(false)
  const control = view.state?.control
  useEffect(() => {
    if (control === 'released' || control === 'occupied' || !view.state) setReleasing(false)
  }, [control, view.state])
  const line = cloudBrowserLine({
    assistance: view.assistance,
    live: view.live,
    status: view.status,
    state: view.state,
    linkState: view.linkState,
    hasFrame: !!view.frame,
    releasing,
    everOpened,
  })
  const takeControl = useCallback(() => {
    view.send({ type: 'control_acquire' })
  }, [view])
  const release = useCallback(() => {
    setReleasing(true)
    if (!view.send({ type: 'control_release' })) setReleasing(false)
  }, [view])
  const askStop = useCallback(() => setStopAsked(true), [])
  const resume = useCallback(() => {
    view.send({ type: 'automation_resume' })
  }, [view])
  const openVault = useCallback(() => setVaultOpen(true), [setVaultOpen])
  const submitVault = useCallback(
    (input: { username: string; password: string; save: boolean }) =>
      new Promise<VaultOutcome>((resolve) => {
        const requestId = view.assistance?.requestId
        if (!requestId) return resolve({ ok: false, reason: 'gone' })
        let off = () => {}
        const timer = setTimeout(() => {
          off()
          resolve({ ok: false, reason: 'offline' })
        }, 30_000)
        off = view.onServerMessage((message: CloudBrowserServerMessage) => {
          if (message.type !== 'vault_result' || message.requestId !== requestId) return
          clearTimeout(timer)
          off()
          resolve(message.ok ? { ok: true } : { ok: false, reason: message.reason ?? 'gone' })
        })
        if (!view.send({ type: 'vault_submit', requestId, ...input })) {
          clearTimeout(timer)
          off()
          resolve({ ok: false, reason: 'offline' })
        }
      }),
    [view],
  )
  const controls: Controls = { view, line, releasing, takeControl, release, askStop, resume, openVault }
  return { controls, vaultOpen, setVaultOpen, stopAsked, setStopAsked, submitVault }
}

/**
 * 主按钮:接管 / 取消接管申请 / 交还 / 正在交还…;agent 请人登录时「登录 某站」(保险箱)在前、「接管浏览器」也在 ——
 * 人也可以自己接管、在页面上登录,做完点「完成」(DoneAction)。
 */
function PrimaryAction({ controls }: { controls: Controls }) {
  const { t } = useTranslation('browserUse')
  const { view, line } = controls
  if (!view.live) return null
  const control = view.state?.control ?? 'released'
  const automation = view.state?.automation ?? view.status?.automation ?? 'idle'
  const assistance = view.assistance ?? null
  const disabled = !view.state || line.key === 'viewer.ended' || control === 'occupied'
  if (controls.releasing) {
    return (
      <Button variant="secondary" size="sm" disabled>
        <LoadingIndicator size="inline" /> {t('viewer.releasingControl')}
      </Button>
    )
  }
  if (control === 'granted') {
    return (
      <Button variant="primary" size="sm" onClick={controls.release}>
        <Check size={14} /> {t('viewer.releaseControl')}
      </Button>
    )
  }
  if (control === 'pending') {
    return (
      <Button variant="secondary" size="sm" onClick={controls.release}>
        <LoadingIndicator size="inline" /> {t('viewer.cancelControl')}
      </Button>
    )
  }
  if (assistance?.kind === 'login' && automation !== 'stopped') {
    return (
      <>
        <Button variant="primary" size="sm" onClick={controls.openVault}>
          <KeyRound size={14} /> {t('vault.login', { site: siteLabel(assistance.site) })}
        </Button>
        <Button variant="secondary" size="sm" onClick={controls.takeControl} disabled={disabled}>
          {t('viewer.takeControl')}
        </Button>
      </>
    )
  }
  return (
    <Button variant="primary" size="sm" onClick={controls.takeControl} disabled={disabled || automation === 'stopped'}>
      {t('viewer.takeControl')}
    </Button>
  )
}

/**
 * 「完成」:答这个任务等着的那一问(agent 请人登录 / 接手一步)。人接管、自己在页面上做完时按它 —— 还拿着控制权的,
 * server 答完会替人交还。接手一步(takeover)交还控制时 server 也会自己答,这一个按钮两种都管。
 */
function DoneAction({ view }: { view: BrowserUseView }) {
  const { t } = useTranslation('browserUse')
  const [busy, setBusy] = useState(false)
  if (!view.assistance) return null
  return (
    <Button
      variant={view.state?.control === 'granted' ? 'primary' : 'secondary'}
      size="sm"
      data-testid="browser-use-done"
      disabled={busy}
      onClick={() => {
        setBusy(true)
        void view.finishAssistance().finally(() => setBusy(false))
      }}
    >
      <Check size={14} /> {t('viewer.done')}
    </Button>
  )
}

function StopAction({ controls }: { controls: Controls }) {
  const { t } = useTranslation('browserUse')
  const { view } = controls
  if (!view.live || !view.state) return null
  if (view.state.automation === 'stopped') {
    return (
      <Button variant="secondary" size="sm" onClick={controls.resume}>
        {t('viewer.resumeAutomation')}
      </Button>
    )
  }
  return (
    <Button variant="secondary" size="sm" onClick={controls.askStop} disabled={view.state.control === 'granted'}>
      <Square size={12} /> {t('viewer.stopAutomation')}
    </Button>
  )
}

function Confirm({
  title,
  description,
  confirm,
  onConfirm,
  onClose,
  danger,
}: {
  title: string
  description: string
  confirm: string
  onConfirm: () => void
  onClose: () => void
  danger?: boolean
}) {
  const { t } = useTranslation('browserUse')
  const titleId = useId()
  return (
    <Sheet onClose={onClose} titleId={titleId} desktopWidth="min(380px, 100%)" mobileFitContent>
      <div className="bu-dialog">
        <h2 id={titleId} className="bu-dialog-title">{title}</h2>
        <p className="bu-dialog-text">{description}</p>
        <div className="bu-actions">
          <Button variant="secondary" onClick={onClose}>{t('viewer.cancel')}</Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            onClick={() => {
              onConfirm()
              onClose()
            }}
          >
            {confirm}
          </Button>
        </div>
      </div>
    </Sheet>
  )
}

function Placeholder({ line, onRetry }: { line: CloudBrowserLine; onRetry?: () => void }) {
  const { t } = useTranslation('browserUse')
  const failed = line.key === 'viewer.error' || line.key === 'viewer.disconnected' || line.key === 'viewer.ended'
  return (
    <div className="bu-placeholder">
      {failed ? null : <LoadingIndicator size="inline" />}
      <span>{failed ? lineText(line, t) : t('viewer.preparing')}</span>
      {line.retry && onRetry ? (
        <Button variant="secondary" size="sm" onClick={onRetry}>
          <RefreshCw size={14} /> {t('viewer.retry')}
        </Button>
      ) : null}
    </div>
  )
}

function TabStrip({
  tabs,
  selected,
  holder,
  onSelect,
  onClose,
}: {
  tabs: CloudBrowserTab[]
  selected: string | null
  holder: boolean
  onSelect: (tabId: string) => void
  /** 没有实时连接(只看图)就关不了页签:不给关闭按钮。 */
  onClose: ((tabId: string) => void) | null
}) {
  const { t } = useTranslation('browserUse')
  return (
    <div role="tablist" aria-label={t('viewer.tabs')} className="bu-tabs">
      {tabs.map((tab) => {
        const active = tab.tabId === selected
        return (
          <div key={tab.tabId} role="tab" aria-selected={active} title={tab.url} onClick={() => onSelect(tab.tabId)} className="bu-tab">
            <Globe size={12} />
            <span className="bu-tab-title">{tab.title || tab.url || t('viewer.title')}</span>
            {onClose ? (
              <IconButton
                size="sm"
                aria-label={t('viewer.closeTab')}
                onClick={(event) => {
                  event.stopPropagation()
                  onClose(tab.tabId)
                }}
                className="bu-tab-close"
                data-locked={!holder || undefined}
              >
                <X size={12} />
              </IconButton>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

function TextBar({ view }: { view: BrowserUseView }) {
  const { t } = useTranslation('browserUse')
  const [text, setText] = useState('')
  const [problem, setProblem] = useState<'inputFailed' | 'inputPartiallySent' | 'inputInvalid' | null>(null)
  const sending = useRef(false)
  const send = async () => {
    if (!text || sending.current) return
    sending.current = true
    setProblem(null)
    const chunks = chunkText(text)
    let sent = 0
    for (const chunk of chunks) {
      const id = nextTextId()
      const ok = await new Promise<boolean>((resolve) => {
        let off = () => {}
        const timer = setTimeout(() => {
          off()
          resolve(false)
        }, 10_000)
        off = view.onServerMessage((message) => {
          if (message.type !== 'input_result' || message.id !== id) return
          clearTimeout(timer)
          off()
          resolve(message.ok)
        })
        if (!view.send({ type: 'input_text', id, text: chunk })) {
          clearTimeout(timer)
          off()
          resolve(false)
        }
      })
      if (!ok) break
      sent += chunk.length
    }
    sending.current = false
    if (sent === text.length) {
      setText('')
      return
    }
    setText(text.slice(sent))
    setProblem(sent > 0 ? 'inputPartiallySent' : 'inputFailed')
  }
  return (
    <div className="bu-textbar">
      {problem ? (
        <div role="alert" className="bu-textbar-alert">
          <span className="bu-grow">{t(`viewer.${problem}`)}</span>
          {problem !== 'inputInvalid' ? <Button variant="ghost" size="sm" onClick={() => void send()}>{t('viewer.retryInput')}</Button> : null}
          <Button variant="ghost" size="sm" onClick={() => { setText(''); setProblem(null) }}>{t('viewer.discardInput')}</Button>
        </div>
      ) : null}
      <form
        className="bu-textbar-form"
        onSubmit={(event) => {
          event.preventDefault()
          void send()
        }}
      >
        <input value={text} onChange={(event) => setText(event.currentTarget.value)} placeholder={t('viewer.textPlaceholder')} className="bu-textbar-input" />
        <Button variant="secondary" size="md" type="submit" disabled={!text}>{t('viewer.sendText')}</Button>
      </form>
    </div>
  )
}

/** 咕咕 server 上那个 Chrome,填满页签。 */
function ServerBrowser({
  deviceId,
  machineLabel,
  sessionId,
  active,
  direct,
}: {
  deviceId: string
  machineLabel: string
  sessionId: string
  active: boolean
  direct: boolean
}) {
  const { t } = useTranslation('browserUse')
  const [viewTab, setViewTab] = useState<string | null>(null)
  const pageVisible = usePageVisible()
  const view = useBrowserUse(deviceId, sessionId, canOpenLiveBrowser() && direct, { framesEnabled: active && pageVisible, tabId: viewTab })
  const everOpened = useRef(false)
  if (view.linkState === 'open') everOpened.current = true
  const { controls, vaultOpen, setVaultOpen, stopAsked, setStopAsked, submitVault } = useControls(view, everOpened.current, active)
  const [closeAsk, setCloseAsk] = useState<{ tabId: string; kind: 'control' | 'last' } | null>(null)
  const [tabProblem, setTabProblem] = useState(false)
  const [invalidText, setInvalidText] = useState(false)
  useEffect(
    () =>
      view.onServerMessage((message) => {
        if (message.type === 'tab_close_result' && !message.closed) setTabProblem(true)
      }),
    [view],
  )

  if (view.unsupported) return <Empty>{t('place.unsupported', { machine: machineLabel })}</Empty>
  if (!view.status) {
    return (
      <Empty>
        <LoadingIndicator size="inline" />
        <p>{t('place.loading', { machine: machineLabel })}</p>
      </Empty>
    )
  }
  if (!view.status.available) return <Empty>{t('place.noChrome', { machine: machineLabel })}</Empty>
  if (!view.status.running && !view.state?.running) return <Empty>{t(view.status.ended ? 'place.ended' : 'place.notRunning')}</Empty>

  const { line } = controls
  const tabs = view.state?.tabs ?? view.status.tabs
  const selected = viewTab && tabs.some((tab) => tab.tabId === viewTab) ? viewTab : view.state?.activeTabId ?? view.status.activeTabId ?? tabs[0]?.tabId ?? null
  const current = tabs.find((tab) => tab.tabId === selected)
  const holder = view.state?.control === 'granted'
  const select = (tabId: string) => {
    setViewTab(tabId)
    if (holder) view.send({ type: 'tab_select', tabId })
  }
  const close = (tabId: string) => {
    setTabProblem(false)
    if (!holder) return setCloseAsk({ tabId, kind: 'control' })
    if (tabs.length <= 1) return setCloseAsk({ tabId, kind: 'last' })
    view.send({ type: 'tab_close', tabId })
  }
  const frame = view.frame && view.frame.tabId === selected ? view.frame : view.frame && !view.live ? view.frame : null
  const loginAsk = view.assistance?.kind === 'login' ? view.assistance : null
  const url = current?.url && current.url !== 'about:blank' ? current.url : undefined
  return (
    <div className="bu-page" data-testid="browser-use-page">
      <div className="bu-row">
        <div className="bu-head-text">
          <h2 className="bu-title">
            {current?.title || t('viewer.title')}
            {holder ? <span aria-hidden className="bu-dot" /> : null}
          </h2>
          <span className="bu-line" data-browser-use-line={line.key} data-needs={line.key === 'needs' || undefined}>
            {lineText(line, t)}
            {url ? ` · ${url}` : ''}
          </span>
        </div>
        <div className="bu-row-wrap">
          <PrimaryAction controls={controls} />
          <DoneAction view={view} />
          <StopAction controls={controls} />
        </div>
      </div>
      {!view.live ? <div role="status" className="bu-caption">{t('place.viewOnly', { machine: machineLabel })}</div> : null}
      {view.live && loginAsk ? <div role="status" className="bu-caption">{t('viewer.loginOrTakeOver')}</div> : null}
      {tabProblem ? <div role="alert" className="bu-alert">{t('viewer.tabCloseFailed')}</div> : null}
      {line.key === 'viewer.occupied' ? <div role="status" className="bu-caption">{t('viewer.controlOccupied')}</div> : null}
      {invalidText ? <div role="alert" className="bu-alert">{t('viewer.inputInvalid')}</div> : null}
      {tabs.length > 0 ? <TabStrip tabs={tabs} selected={selected} holder={holder} onSelect={select} onClose={view.live ? close : null} /> : null}
      <div className="bu-preview" data-controlling={holder || undefined}>
        <BrowserUseScreen frame={frame} interactive={holder} onAck={view.ack} send={view.send} onInvalidText={() => setInvalidText(true)} />
        {!frame || line.retry ? <Placeholder line={line} onRetry={view.reconnect} /> : null}
      </div>
      {holder ? <TextBar view={view} /> : null}
      {closeAsk?.kind === 'control' ? (
        <Confirm
          title={t('viewer.controlRequiredTitle')}
          description={t('viewer.controlRequiredDescription')}
          confirm={t('viewer.takeControl')}
          onConfirm={() => view.send({ type: 'control_acquire' })}
          onClose={() => setCloseAsk(null)}
        />
      ) : null}
      {closeAsk?.kind === 'last' ? (
        <Confirm
          title={t('viewer.lastTabTitle')}
          description={t('viewer.lastTabDescription')}
          confirm={t('viewer.closeLastTab')}
          danger
          onConfirm={() => view.send({ type: 'tab_close', tabId: closeAsk.tabId })}
          onClose={() => setCloseAsk(null)}
        />
      ) : null}
      {vaultOpen && loginAsk ? (
        <BrowserUseVault key={loginAsk.requestId} assistance={loginAsk} onSubmit={submitVault} onClose={() => setVaultOpen(false)} />
      ) : null}
      {stopAsked ? (
        <Confirm
          title={t('viewer.stopTitle')}
          description={t('viewer.stopDescription')}
          confirm={t('viewer.stopAutomation')}
          danger
          onConfirm={() => view.send({ type: 'automation_stop' })}
          onClose={() => setStopAsked(false)}
        />
      ) : null}
    </div>
  )
}
