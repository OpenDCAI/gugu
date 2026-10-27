import { useAgentSessionRow } from '@/mobile/agent-watch/useAgentSessionRow'
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import '../../i18n/registerCloudBrowserCatalog'
import './cloudBrowser.css'
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator'
import { Check, Globe, KeyRound, Maximize2, MoreHorizontal, RefreshCw, Square, X } from '@/lib/icons'
import type { CloudBrowserServerMessage, CloudBrowserTab } from '@/session/shared/cloud-browser'
import { Button } from '../ui/Button'
import { DropdownMenu, menuRowClassName } from '../ui/Menu'
import { IconButton } from '../ui/IconButton'
import { Sheet } from '../ui/Sheet'
import { cloudBrowserLine, siteLabel, type CloudBrowserLine } from './cloudBrowserLabels'
import { CloudBrowserScreen } from './CloudBrowserScreen'
import { chunkText, nextTextId } from './screenMath'
import { CloudBrowserVault, type VaultOutcome } from './CloudBrowserVault'
import { useCloudBrowser, type CloudBrowserSize, type CloudBrowserView } from './useCloudBrowser'

/**
 * #7199 云浏览器小窗(浏览器卡片 + 大窗):和云电脑上的 agent 私聊时,它在那台机器上开浏览器干活,
 * 输入框上方出现这一块 —— 实时画面、它在干嘛;「浏览器窗口选项」切小窗 / 中等 / 放大;放大后能接管、打字、发文字、
 * 切换和关闭标签页,用完交还给 Agent;agent 要登录时弹密码保险箱。手机上只看(没有远程隧道)。
 */

const SIZE_KEY = 'gugu.cloudBrowser.size'

/**
 * 这是谁的浏览器:聊天对象的名字(如「个人助理」)。文案里说「个人助理正在浏览」「交还给个人助理」——
 * 人只认识助理,❌「Agent」、❌ 说它在哪台机器上。
 */
const AgentNameContext = createContext('')

function useCloudBrowserT(): (key: string, options?: Record<string, unknown>) => string {
  const { t } = useTranslation('cloudBrowser')
  const name = useContext(AgentNameContext)
  return useCallback((key: string, options?: Record<string, unknown>) => t(key, { name: name || t('viewer.agentFallback'), ...options }), [t, name])
}

function readSize(): Exclude<CloudBrowserSize, 'large'> {
  try {
    return localStorage.getItem(SIZE_KEY) === 'small' ? 'small' : 'medium'
  } catch {
    return 'medium'
  }
}

function writeSize(size: Exclude<CloudBrowserSize, 'large'>): void {
  try {
    localStorage.setItem(SIZE_KEY, size)
  } catch {
    // 记不住就下次回到中等
  }
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

function useOnScreen<T extends Element>(): [(node: T | null) => void, boolean] {
  const [node, setNode] = useState<T | null>(null)
  const [onScreen, setOnScreen] = useState(true)
  useEffect(() => {
    if (!node || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver((entries) => setOnScreen(entries.some((entry) => entry.isIntersecting)))
    observer.observe(node)
    return () => observer.disconnect()
  }, [node])
  return [setNode, onScreen]
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

function useControls(view: CloudBrowserView, everOpened: boolean, openLarge: () => void): Controls & { vaultOpen: boolean; setVaultOpen: (open: boolean) => void; stopAsked: boolean; setStopAsked: (open: boolean) => void; submitVault: (input: { username: string; password: string; save: boolean }) => Promise<VaultOutcome> } {
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
    openLarge()
    view.send({ type: 'control_acquire' })
  }, [openLarge, view])
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
function PrimaryAction({ controls, inLarge }: { controls: Controls; inLarge: boolean }) {
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
    <Button variant={assistance?.kind === 'takeover' || inLarge ? 'primary' : 'secondary'} size="sm" onClick={controls.takeControl} disabled={disabled || automation === 'stopped'}>
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

/** 放大:大窗(桌面居中、手机全屏)。 */
function CloudBrowserWindow({
  controls,
  viewTab,
  setViewTab,
  onClose,
  dialogs,
}: {
  controls: Controls
  viewTab: string | null
  setViewTab: (tabId: string | null) => void
  onClose: () => void
  /** 大窗开着时,保险箱与停止确认框叠在它里面(嵌套的弹层才不被大窗的焦点圈挡住)。 */
  dialogs: ReactNode
}) {
  const t = useCloudBrowserT()
  const titleId = useId()
  const { view, line } = controls
  const tabs = view.state?.tabs ?? view.status?.tabs ?? []
  const selected = viewTab && tabs.some((tab) => tab.tabId === viewTab) ? viewTab : view.state?.activeTabId ?? view.status?.activeTabId ?? tabs[0]?.tabId ?? null
  const current = tabs.find((tab) => tab.tabId === selected)
  const holder = view.state?.control === 'granted'
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
  return (
    <Sheet
      onClose={onClose}
      titleId={titleId}
      desktopWidth="min(1300px, calc(100vw - 32px), calc((100dvh - 200px) * 16 / 9 + 32px))"
      desktopMaxHeight="calc(100dvh - 32px)"
      fullScreenMobile
    >
      <div className="cb-window">
        <div className="cb-row">
          <div className="cb-head-text">
            <h2 id={titleId} className="cb-big-title">
              {current?.title || t('viewer.titleOf')}
              {holder ? <span aria-hidden className="cb-dot" /> : null}
            </h2>
            <StatusLine line={line} url={current?.url && current.url !== 'about:blank' ? current.url : undefined} />
          </div>
          <PrimaryAction controls={controls} inLarge />
          <StopAction controls={controls} />
          <IconButton aria-label={t('viewer.minimize')} onClick={onClose}>
            <X size={16} />
          </IconButton>
        </div>
        {tabProblem ? <div role="alert" className="cb-alert">{t('viewer.tabCloseFailed')}</div> : null}
        {line.key === 'viewer.occupied' ? <div role="status" className="cb-caption">{t('viewer.controlOccupied')}</div> : null}
        {invalidText ? <div role="alert" className="cb-alert">{t('viewer.inputInvalid')}</div> : null}
        {tabs.length > 0 ? <TabStrip tabs={tabs} selected={selected} holder={holder} onSelect={select} onClose={view.live ? close : null} /> : null}
        <div className="cb-preview" data-big="" data-controlling={holder || undefined}>
          <CloudBrowserScreen
            frame={frame}
            interactive={holder}
            onAck={view.ack}
            send={view.send}
            onInvalidText={() => setInvalidText(true)}
          />
          {!frame || line.retry ? <Placeholder line={line} onRetry={view.reconnect} /> : null}
        </div>
        {holder ? <TextBar view={view} /> : null}
      </div>
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
      {dialogs}
    </Sheet>
  )
}

function IconTile({ line }: { line: CloudBrowserLine }) {
  const tone =
    line.key === 'needs'
      ? 'needs'
      : line.key === 'viewer.taskCompleted'
        ? 'done'
        : line.key === 'viewer.watching' || line.key === 'viewer.openingSite' || line.key === 'viewer.controlling'
          ? 'live'
          : undefined
  return (
    <span className="cb-tile" data-tone={tone}>
      <Globe size={14} />
    </span>
  )
}

/** 输入框上方那一块。`deviceId` = agent 所在的那台咕咕 server(不是 = null,什么都不出)。 */
export function CloudBrowserCard({ deviceId, agentName, agentUserId }: { deviceId: string | null; agentName: string; agentUserId: string | null }) {
  return (
    <AgentNameContext.Provider value={agentName.trim()}>
      <CloudBrowserCardInner deviceId={deviceId} agentUserId={agentUserId} />
    </AgentNameContext.Provider>
  )
}

function CloudBrowserCardInner({ deviceId, agentUserId }: { deviceId: string | null; agentUserId: string | null }) {
  const t = useCloudBrowserT()
  const [size, setSize] = useState<Exclude<CloudBrowserSize, 'large'>>(readSize)
  const [large, setLarge] = useState(false)
  const [viewTab, setViewTab] = useState<string | null>(null)
  const pageVisible = usePageVisible()
  const [cardRef, onScreen] = useOnScreen<HTMLDivElement>()
  const row = useAgentSessionRow(agentUserId)
  const view = useCloudBrowser(deviceId, { framesEnabled: pageVisible && (large || onScreen), large, tabId: viewTab }, row?.session.conversationId ?? null)
  const everOpened = useRef(false)
  if (view.linkState === 'open') everOpened.current = true
  const openLarge = useCallback(() => setLarge(true), [])
  const controls = useControls(view, everOpened.current, openLarge)
  const closeLarge = useCallback(() => {
    // 关大窗还拿着控制权 = 交还。
    if (view.state?.control === 'granted' || view.state?.control === 'pending') controls.release()
    setLarge(false)
  }, [view.state?.control, controls])

  if (!view.shown) return null
  const tabs = view.state?.tabs ?? view.status?.tabs ?? []
  const activeId = viewTab ?? view.state?.activeTabId ?? view.status?.activeTabId ?? null
  const active = tabs.find((tab) => tab.tabId === activeId) ?? tabs[0]
  const frame = view.frame
  const pick = (next: CloudBrowserSize) => {
    if (next === 'large') return setLarge(true)
    setSize(next)
    writeSize(next)
  }
  const loginAsk = view.assistance?.kind === 'login' ? view.assistance : null
  const dialogs = (
    <>
      {view.error ? <p role="alert">{view.error}</p> : null}
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
    </>
  )
  const row = (key: CloudBrowserSize, label: string): ReactNode => (
    <DropdownMenu.RadioItem key={key} value={key} className={menuRowClassName} onClick={() => pick(key)}>
      {label}
    </DropdownMenu.RadioItem>
  )

  return (
    <div ref={cardRef} data-cloud-browser-card="" className="cb-card" data-size={size}>
      <div className="cb-row">
        <IconTile line={controls.line} />
        <div className="cb-head-text">
          <span className="cb-title">{t('viewer.titleOf')}</span>
          <StatusLine line={controls.line} />
        </div>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger render={<IconButton size="sm" aria-label={t('viewer.options')}><MoreHorizontal size={14} /></IconButton>} />
          <DropdownMenu.Content align="end">
            <DropdownMenu.RadioGroup value={large ? 'large' : size}>
              {row('small', t('viewer.small'))}
              {row('medium', t('viewer.medium'))}
              {row('large', t('viewer.large'))}
            </DropdownMenu.RadioGroup>
          </DropdownMenu.Content>
        </DropdownMenu.Root>
        <IconButton size="sm" aria-label={t('viewer.expand')} onClick={() => setLarge(true)}>
          <Maximize2 size={14} />
        </IconButton>
        <IconButton size="sm" aria-label={t('viewer.close')} onClick={view.dismiss}>
          <X size={14} />
        </IconButton>
      </div>
      <div className="cb-preview">
        <CloudBrowserScreen frame={frame} interactive={false} onAck={view.ack} send={view.send} onActivate={() => setLarge(true)} />
        {!frame || controls.line.retry || controls.line.key === 'viewer.ended' ? <Placeholder line={controls.line} onRetry={view.reconnect} /> : null}
      </div>
      {active?.url && active.url !== 'about:blank' && size === 'medium' ? (
        <span className="cb-url" title={active.url}>
          {active.title || active.url}
        </span>
      ) : null}
      {view.live ? (
        <div className="cb-row-wrap">
          <PrimaryAction controls={controls} inLarge={false} />
          <StopAction controls={controls} />
        </div>
      ) : null}
      {large ? <CloudBrowserWindow controls={controls} viewTab={viewTab} setViewTab={setViewTab} onClose={closeLarge} dialogs={dialogs} /> : dialogs}
    </div>
  )
}
