import { useEffect, useRef, useState, type FormEvent } from 'react'
import QRCode from 'qrcode'
import { useTranslation } from 'react-i18next'
import type { ChatChannelList, ChatChannelLogin, ChatChannelsClient } from '@gugu/core/cloud/chatChannels'
import { CheckCircle } from '@/lib/icons'
import { Button } from '../../ui/Button'
import { Sheet } from '../../ui/Sheet'
import { ChannelAgentPicker } from './ChannelAgentPicker'
import { useOwnedAgents } from './channelAgents'
import { platform } from '../../../platform'
import { ChannelBrandIcon } from './ChannelBrandIcon'

const body = 'text-[length:var(--font-body)] leading-[1.5]'

function Spinner() {
  return (
    <span
      aria-hidden
      className="inline-block size-6 rounded-full border-[3px] border-[var(--border-color)] border-t-[var(--accent)] animate-[spin_0.8s_linear_infinite]"
    />
  )
}

function QrImage({ text, alt }: { text: string; alt: string }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    void QRCode.toDataURL(text, { width: 200, margin: 1, color: { dark: '#111111', light: '#ffffff' } }).then((url) => {
      if (!cancelled) setDataUrl(url)
    })
    return () => {
      cancelled = true
    }
  }, [text])
  return (
    <div className="flex size-[200px] items-center justify-center overflow-hidden rounded-[var(--radius-control)] border border-[var(--border-subtle)] bg-[var(--color-white)]">
      {dataUrl ? <img src={dataUrl} alt={alt} width={200} height={200} data-testid="wechat-connect-qr" /> : <Spinner />}
    </div>
  )
}

function VerifyForm({ wrong, onSubmit }: { wrong: boolean; onSubmit: (code: string) => void }) {
  const { t } = useTranslation('settings')
  const [code, setCode] = useState('')
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (code.trim()) onSubmit(code.trim())
    setCode('')
  }
  return (
    <form className="flex w-full flex-col items-center gap-3" onSubmit={submit}>
      <div className={`${body} text-center text-[var(--fg)]`}>{t('channels.dialog.verifyTitle')}</div>
      {wrong ? <div className={`${body} text-[var(--danger)]`}>{t('channels.dialog.verifyWrong')}</div> : null}
      <div className="flex gap-2">
        <input
          autoFocus
          inputMode="numeric"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          placeholder={t('channels.dialog.verifyPlaceholder')}
          data-testid="wechat-connect-verify-input"
          className="h-8 w-40 rounded-[var(--radius-control)] border border-[var(--border-color)] bg-[var(--bg)] px-2 text-center text-[length:var(--font-body)] tracking-[0.2em] text-[var(--fg)]"
        />
        <Button size="sm" variant="primary" type="submit" disabled={!code.trim()}>
          {t('channels.dialog.verifySubmit')}
        </Button>
      </div>
    </form>
  )
}

function FailedView({ view, onRetry }: { view: Extract<ChatChannelLogin, { phase: 'failed' }>; onRetry: () => void }) {
  const { t } = useTranslation('settings')
  const expired = view.reason === 'expired'
  return (
    <div className="flex w-full flex-col items-center gap-3" data-testid={`wechat-connect-failed-${view.reason}`}>
      <div className={`${body} text-center font-medium text-[var(--fg)]`}>
        {expired
          ? view.everScanned ? t('channels.dialog.failed.expiredScanned') : t('channels.dialog.failed.expired')
          : t(`channels.dialog.failed.${view.reason}`)}
      </div>
      {expired && !view.everScanned ? (
        // 被风控拦下时服务端看不出区别(只回 wait 直到过期,官方仓 issue #333),所以三种可能都说出来,让人对号入座。
        <ul className={`${body} flex list-disc flex-col gap-1 pl-5 text-[var(--muted-fg)]`}>
          <li>{t('channels.dialog.failed.expiredHintNotScanned')}</li>
          <li>{t('channels.dialog.failed.expiredHintRisk')}</li>
          <li>{t('channels.dialog.failed.expiredHintVersion')}</li>
        </ul>
      ) : null}
      <Button size="sm" variant="primary" onClick={onRetry} data-testid="wechat-connect-retry">
        {t('channels.dialog.retry')}
      </Button>
    </div>
  )
}

/** 扫码这几步还在进行:界面每秒问一次管家。 */
const POLL_MS = 1_000

function inProgress(view: ChatChannelLogin | null): boolean {
  return view === null || view.phase === 'loading' || view.phase === 'qr' || view.phase === 'scanned' || view.phase === 'verify'
}

/**
 * 「连接微信」:二维码 → 扫码 → (手机上的数字)→ 已连接 + 选对接哪个 agent。
 * 二维码由管家去取(收发也在管家上,#7199);打开时开始,关掉就取消这一轮(连上之后关掉不影响连接)。
 * 连上时管家已经默认对接了「个人助理」(没有就空着,让人在这里选)。
 */
export function WechatConnectDialog({
  client,
  list,
  refresh,
  apply,
  onClose,
}: {
  client: ChatChannelsClient
  list: ChatChannelList
  refresh: () => Promise<void>
  apply: (next: ChatChannelList) => void
  onClose: () => void
}) {
  const { t } = useTranslation('settings')
  const agents = useOwnedAgents()
  const [view, setView] = useState<ChatChannelLogin | null>(null)
  const [requestFailed, setRequestFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const refreshedFor = useRef(-1)
  const connected = view?.phase === 'connected'
  const channel = list.channels.find((c) => c.kind === 'wechat') ?? null

  useEffect(() => {
    let alive = true
    setView(null)
    setRequestFailed(false)
    client.startLogin('wechat').then(
      (next) => alive && setView(next),
      () => alive && setRequestFailed(true),
    )
    return () => {
      alive = false
    }
  }, [client, attempt])

  useEffect(() => {
    if (requestFailed || !inProgress(view) || view === null) return
    const timer = setTimeout(() => {
      client.loginView('wechat').then(
        // 管家那边这一轮没了(重启过):当作请求失败,让人重来,❌ 一直转圈。
        (next) => (next ? setView(next) : setRequestFailed(true)),
        () => setRequestFailed(true),
      )
    }, POLL_MS)
    return () => clearTimeout(timer)
  }, [client, view, requestFailed])

  useEffect(() => {
    if (!connected || refreshedFor.current === attempt) return
    refreshedFor.current = attempt
    void refresh()
  }, [connected, attempt, refresh])

  const close = () => {
    if (!connected) void client.cancelLogin('wechat').catch(() => undefined)
    onClose()
  }
  const retry = () => setAttempt((n) => n + 1)

  let content
  if (requestFailed) {
    content = (
      <div className="flex w-full flex-col items-center gap-3" data-testid="wechat-connect-request-failed">
        <div className={`${body} text-center text-[var(--fg)]`}>{t('channels.actionFailed')}</div>
        <Button size="sm" variant="primary" onClick={retry}>{t('channels.dialog.retry')}</Button>
      </div>
    )
  } else if (connected) {
    content = (
      <div className="flex w-full flex-col items-center gap-3" data-testid="wechat-connect-success">
        <CheckCircle aria-hidden className="size-10 text-[var(--ok)]" />
        <div className={`${body} text-center text-[var(--muted-fg)]`}>{t('channels.dialog.connectedBody')}</div>
        <div className="flex w-full items-center justify-between gap-3 rounded-[var(--radius-control)] bg-foreground/[0.03] px-3 py-2">
          <span className={`${body} text-[var(--fg)]`}>{t('channels.agentLabel')}</span>
          <ChannelAgentPicker
            agentId={channel?.agentId ?? null}
            onPick={(id) => void client.setAgent('wechat', id).then(apply, () => setRequestFailed(true))}
            testId="wechat-connect-agent-picker"
          />
        </div>
        <Button size="sm" variant="primary" onClick={onClose} disabled={!channel || (!channel.agentId && agents.length > 0)} data-testid="wechat-connect-done">
          {t('channels.dialog.done')}
        </Button>
      </div>
    )
  } else if (!view || view.phase === 'loading') {
    content = (
      <div className="flex flex-col items-center gap-3 py-6">
        <Spinner />
        <div className={`${body} text-[var(--muted-fg)]`}>{t('channels.dialog.loading')}</div>
      </div>
    )
  } else if (view.phase === 'qr') {
    content = (
      <div className="flex flex-col items-center gap-3">
        <QrImage text={view.qrcodeUrl} alt={t('channels.dialog.qrAlt')} />
        <div className={`${body} text-center text-[var(--fg)]`}>{t('channels.dialog.scan')}</div>
        {platform.kind === 'capacitor' ? <div className={`${body} text-center text-[var(--muted-fg)]`}>{t('channels.dialog.scanFromAlbum')}</div> : null}
        <div className="text-center text-[length:var(--font-caption)] leading-[1.5] text-[var(--muted-fg)]">{t('channels.dialog.scanNote')}</div>
      </div>
    )
  } else if (view.phase === 'scanned') {
    content = (
      <div className="flex flex-col items-center gap-3 py-6" data-testid="wechat-connect-scanned">
        <Spinner />
        <div className={`${body} text-center text-[var(--fg)]`}>{t('channels.dialog.scanned')}</div>
      </div>
    )
  } else if (view.phase === 'verify') {
    content = <VerifyForm wrong={view.wrongCode} onSubmit={(code) => void client.submitVerifyCode('wechat', code).then(setView, () => setRequestFailed(true))} />
  } else {
    content = <FailedView view={view} onRetry={retry} />
  }

  return (
    <Sheet onClose={close} desktopWidth="380px" desktopMaxHeight="80vh" mobileFitContent ariaLabel={t('channels.dialog.title')} testId="wechat-connect-dialog" zIndex="var(--z-settings-modal)">
      <div className="flex flex-col items-center gap-4 overflow-y-auto px-6 pt-6 pb-5">
        <ChannelBrandIcon kind="wechat" size={40} />
        <div className="text-[length:var(--font-title)] font-semibold text-[var(--fg)]">
          {connected ? t('channels.dialog.connectedTitle') : t('channels.dialog.title')}
        </div>
        {content}
        {!connected ? (
          <Button size="sm" variant="ghost" onClick={close}>
            {t('channels.dialog.close')}
          </Button>
        ) : null}
      </div>
    </Sheet>
  )
}
