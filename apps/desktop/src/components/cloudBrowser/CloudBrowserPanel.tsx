import { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import '../../i18n/registerCloudBrowserCatalog'
import './cloudBrowser.css'
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator'
import { Check, Globe, KeyRound, RefreshCw, Square, X } from '@/lib/icons'
import type { CloudBrowserServerMessage, CloudBrowserTab } from '@/session/shared/cloud-browser'
import { Button } from '../ui/Button'
import { IconButton } from '../ui/IconButton'
import { Sheet } from '../ui/Sheet'
import { cloudBrowserLine, siteLabel, type CloudBrowserLine } from './cloudBrowserLabels'
import { CloudBrowserScreen } from './CloudBrowserScreen'
import { chunkText, nextTextId } from './screenMath'
import { CloudBrowserVault, type VaultOutcome } from './CloudBrowserVault'
import { useCloudBrowser, type CloudBrowserView } from './useCloudBrowser'

/**
 * #7199 云浏览器:server 上的 agent 在那台机器的 Chrome 里干活,人在任务页的「浏览器」页签里看 —— 实时画面、它在干嘛;
 * 能接管、打字、发文字、切换和关闭标签页,用完交还给 Agent;agent 要登录时弹密码保险箱。
 * 只在这个页签里(owner 10-28「我们不是通过页签来展示吗」):聊天页 ❌ 浮小窗。
 */

/**
 * 这是谁的浏览器:agent 的名字。文案里说「交还给 X」;不知道名字就说「助理」—— ❌「Agent」、❌ 说它在哪台机器上。
 */
const AgentNameContext = createContext('')

function useCloudBrowserT(): (key: string, options?: Record<string, unknown>) => string {
  const { t } = useTranslation('cloudBrowser')
  const name = useContext(AgentNameContext)
  return useCallback((key: string, options?: Record<string, unknown>) => t(key, { name: name || t('viewer.agentFallback'), ...options }), [t, name])
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

function lineText(line: CloudBrowserLine, t: (key: string, options?: Record<string, unknown>) => string): string {
  if (line.key !== 'needs') return t(line.key)
  const what =
    line.assistance.text ??
    (line.assistance.kind === 'login' ? t('vault.login', { site: siteLabel(line.assistance.site) }) : t('viewer.requestTakeover'))
  return `${t('viewer.needsUserAction')} · ${what}`
}

type Controls = {
  view: CloudBrowserView
  line: CloudBrowserLine
  releasing: boolean
  takeControl: () => void
  release: () => void
  askStop: () => void
  resume: () => void
  openVault: () => void
}

function useControls(view: CloudBrowserView, everOpened: boolean): Controls & { vaultOpen: boolean; setVaultOpen: (open: boolean) => void; stopAsked: boolean; setStopAsked: (open: boolean) => void; submitVault: (input: { username: string; password: string; save: boolean }) => Promise<VaultOutcome> } {
  const [releasing, setReleasing] = useState(false)
  // 开的是哪一次请求的保险箱:那次请求结束(填好 / 超时 / 被关掉)它就不算开着,下一次请求要人再点一下。
  const [vaultFor, setVaultFor] = useState<string | null>(null)
  const askId = view.assistance?.kind === 'login' ? view.assistance.requestId : null
  const vaultOpen = !!askId && vaultFor === askId
  const setVaultOpen = useCallback((open: boolean) => setVaultFor(open ? askId : null), [askId])
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
  return { view, line, releasing, takeControl, release, askStop, resume, openVault, vaultOpen, setVaultOpen, stopAsked, setStopAsked, submitVault }
}

/** 主按钮:接管 / 取消接管申请 / 交还给 Agent / 正在交还…;agent 请人登录时是「登录 某站」。 */
function PrimaryAction({ controls }: { controls: Controls }) {
  const t = useCloudBrowserT()
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
      <Button variant="primary" size="sm" onClick={controls.openVault} disabled={disabled}>
        <KeyRound size={14} /> {t('vault.login', { site: siteLabel(assistance.site) })}
      </Button>
    )
  }
  return (
    <Button variant="primary" size="sm" onClick={controls.takeControl} disabled={disabled || automation === 'stopped'}>
      {t('viewer.takeControl')}
    </Button>
  )
}

function StopAction({ controls }: { controls: Controls }) {
  const t = useCloudBrowserT()
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
  const t = useCloudBrowserT()
  const titleId = useId()
  return (
    <Sheet onClose={onClose} titleId={titleId} desktopWidth="min(380px, 100%)" mobileFitContent>
      <div className="cb-dialog">
        <h2 id={titleId} className="cb-dialog-title">{title}</h2>
        <p className="cb-dialog-text">{description}</p>
        <div className="cb-actions">
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

function StatusLine({ line, url }: { line: CloudBrowserLine; url?: string }) {
  const t = useCloudBrowserT()
  return (
    <span className="cb-line" data-cloud-browser-line={line.key} data-needs={line.key === 'needs' || undefined}>
      {lineText(line, t)}
      {url ? ` · ${url}` : ''}
    </span>
  )
}

function Placeholder({ line, onRetry }: { line: CloudBrowserLine; onRetry?: () => void }) {
  const t = useCloudBrowserT()
  const failed = line.key === 'viewer.error' || line.key === 'viewer.disconnected' || line.key === 'viewer.ended'
  return (
    <div className="cb-placeholder">
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
  /** 没有实时连接(手机只看图)就关不了页签:不给关闭按钮。 */
  onClose: ((tabId: string) => void) | null
}) {
  const t = useCloudBrowserT()
  return (
    <div role="tablist" aria-label={t('viewer.tabs')} className="cb-tabs">
      {tabs.map((tab) => {
        const active = tab.tabId === selected
        return (
          <div
            key={tab.tabId}
            role="tab"
            aria-selected={active}
            title={tab.url}
            onClick={() => onSelect(tab.tabId)}
            className="cb-tab"
          >
            <Globe size={12} />
            <span className="cb-tab-title">{tab.title || tab.url || t('viewer.title')}</span>
            {onClose ? (
              <IconButton
                size="sm"
                aria-label={t('viewer.closeTab')}
                onClick={(event) => {
                  event.stopPropagation()
                  onClose(tab.tabId)
                }}
                className="cb-tab-close"
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

function TextBar({ view }: { view: CloudBrowserView }) {
  const t = useCloudBrowserT()
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
    <div className="cb-textbar">
      {problem ? (
        <div role="alert" className="cb-textbar-alert">
          <span className="cb-grow">{t(`viewer.${problem}`)}</span>
          {problem !== 'inputInvalid' ? <Button variant="ghost" size="sm" onClick={() => void send()}>{t('viewer.retryInput')}</Button> : null}
          <Button variant="ghost" size="sm" onClick={() => { setText(''); setProblem(null) }}>{t('viewer.discardInput')}</Button>
        </div>
      ) : null}
      <form
        className="cb-textbar-form"
        onSubmit={(event) => {
          event.preventDefault()
          void send()
        }}
      >
        <input
          value={text}
          onChange={(event) => setText(event.currentTarget.value)}
          placeholder={t('viewer.textPlaceholder')}
          className="cb-textbar-input"
        />
        <Button variant="secondary" size="md" type="submit" disabled={!text}>{t('viewer.sendText')}</Button>
      </form>
    </div>
  )
}

/**
 * 任务页「浏览器」页签里的那一块。`deviceId` = agent 所在的那台咕咕 server;`sessionId` = 这条会话(它的登录 / 接管求助
 * 挂在这条会话上)。浏览器没开 = 空状态说一句,❌ 一片空白。
 */
export function CloudBrowserPanel({ deviceId, sessionId, agentName = '' }: { deviceId: string; sessionId: string; agentName?: string }) {
  return (
    <AgentNameContext.Provider value={agentName.trim()}>
      <CloudBrowserPanelInner deviceId={deviceId} sessionId={sessionId} />
    </AgentNameContext.Provider>
  )
}

function CloudBrowserPanelInner({ deviceId, sessionId }: { deviceId: string; sessionId: string }) {
  const t = useCloudBrowserT()
  const [viewTab, setViewTab] = useState<string | null>(null)
  const pageVisible = usePageVisible()
  const view = useCloudBrowser(deviceId, { framesEnabled: pageVisible, tabId: viewTab }, sessionId)
  const everOpened = useRef(false)
  if (view.linkState === 'open') everOpened.current = true
  const controls = useControls(view, everOpened.current)
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

  if (!view.open) {
    return (
      <div className="cb-panel" data-cloud-browser-panel="" data-state="empty">
        <div className="cb-empty">
          <span className="cb-empty-icon"><Globe size={20} /></span>
          <span>{t('viewer.empty')}</span>
        </div>
      </div>
    )
  }

  const { line } = controls
  const tabs = view.state?.tabs ?? view.status?.tabs ?? []
  const selected = viewTab && tabs.some((tab) => tab.tabId === viewTab) ? viewTab : view.state?.activeTabId ?? view.status?.activeTabId ?? tabs[0]?.tabId ?? null
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
  return (
    <div className="cb-panel" data-cloud-browser-panel="" data-state="open">
      <div className="cb-row">
        <div className="cb-head-text">
          <span className="cb-big-title">
            {current?.title || t('viewer.titleOf')}
            {holder ? <span aria-hidden className="cb-dot" /> : null}
          </span>
          <StatusLine line={line} url={current?.url && current.url !== 'about:blank' ? current.url : undefined} />
        </div>
        <PrimaryAction controls={controls} />
        <StopAction controls={controls} />
      </div>
      {tabProblem ? <div role="alert" className="cb-alert">{t('viewer.tabCloseFailed')}</div> : null}
      {line.key === 'viewer.occupied' ? <div role="status" className="cb-caption">{t('viewer.controlOccupied')}</div> : null}
      {invalidText ? <div role="alert" className="cb-alert">{t('viewer.inputInvalid')}</div> : null}
      {view.error ? <div role="alert" className="cb-alert">{view.error}</div> : null}
      {tabs.length > 0 ? <TabStrip tabs={tabs} selected={selected} holder={holder} onSelect={select} onClose={view.live ? close : null} /> : null}
      <div className="cb-preview" data-controlling={holder || undefined}>
        <CloudBrowserScreen
          frame={frame}
          interactive={holder}
          onAck={view.ack}
          send={view.send}
          onInvalidText={() => setInvalidText(true)}
        />
        {!frame || line.retry || line.key === 'viewer.ended' ? <Placeholder line={line} onRetry={view.reconnect} /> : null}
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
      {controls.vaultOpen && loginAsk ? (
        <CloudBrowserVault key={loginAsk.requestId} assistance={loginAsk} onSubmit={controls.submitVault} onClose={() => controls.setVaultOpen(false)} />
      ) : null}
      {controls.stopAsked ? (
        <Confirm
          title={t('viewer.stopTitle')}
          description={t('viewer.stopDescription')}
          confirm={t('viewer.stopAutomation')}
          danger
          onConfirm={() => view.send({ type: 'automation_stop' })}
          onClose={() => controls.setStopAsked(false)}
        />
      ) : null}
    </div>
  )
}
