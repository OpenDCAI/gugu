import { useLayoutEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { MachineLimitRefusal } from '@gugu/core/cloud/machineLimit'
import { Button } from '../../components/ui/Button'
import { Sheet } from '../../components/ui/Sheet'
import { MachineLimitNotice } from '../../components/settings/addServer/MachineLimitNotice'
import { PLATFORM_NAMES } from '../../lib/deviceRowModel'
import { rendererLogger } from '../../lib/log'
import { decideServerLogin, readServerLoginRequest, type ServerLoginRequest, type ServerLoginState } from './serverLoginApproval'

const log = rendererLogger('mobile/server-login')

type View =
  | { kind: 'loading' }
  | { kind: 'failed'; message: string }
  | { kind: 'request'; request: ServerLoginRequest; busy: boolean; error: string | null }
  | { kind: 'final'; state: Exclude<ServerLoginState, 'pending'>; hostname: string | null; refusal: MachineLimitRefusal | null }

/**
 * 批准一台跑了 `gugu-server login` 的机器(手机上点了那条链接)。机器信息摆在「允许」正上方,写明只有自己刚在那台机器上
 * 执行了登录才点 —— 与网页确认页同一条防钓鱼规矩。点完等云端答了才换结局,❌ 先报「已允许」。
 */
export function ServerLoginApproveSheet({ code, onDone }: { code: string | null; onDone: () => void }) {
  const { t } = useTranslation('settings')
  const [view, setView] = useState<View>({ kind: 'loading' })

  useLayoutEffect(() => {
    if (code === null) return
    setView({ kind: 'loading' })
    let alive = true
    readServerLoginRequest(code).then(
      (request) => {
        if (!alive) return
        setView(request.state === 'pending'
          ? { kind: 'request', request, busy: false, error: null }
          : { kind: 'final', state: request.state, hostname: request.machine.hostname, refusal: null })
      },
      (error: unknown) => {
        if (!alive) return
        const message = error instanceof Error ? error.message : String(error)
        log.warn({ error: message }, 'server-login view failed')
        setView({ kind: 'failed', message: message === 'not_found' ? t('devices.approveServer.notFound') : t('devices.approveServer.loadFailed') })
      },
    )
    return () => { alive = false }
  }, [code, t])

  const decide = (request: ServerLoginRequest, approve: boolean) => {
    setView({ kind: 'request', request, busy: true, error: null })
    decideServerLogin(request.code, approve).then(
      (decision) => {
        if (decision.state === 'pending') throw new Error('still pending')
        setView({ kind: 'final', state: decision.state, hostname: request.machine.hostname, refusal: decision.refusal })
      },
    ).catch((error: unknown) => {
      log.warn({ error: error instanceof Error ? error.message : String(error) }, 'server-login decide failed')
      setView({ kind: 'request', request, busy: false, error: t('devices.approveServer.decideFailed') })
    })
  }

  const busy = view.kind === 'request' && view.busy
  return (
    <Sheet open={code !== null} onClose={() => { if (!busy) onDone() }} mobileFitContent desktopWidth="380px" testId="server-login-approve" ariaLabel={t('devices.approveServer.title')}>
      <div className="flex flex-col gap-3 px-5 pb-5 pt-6" data-approve-state={view.kind === 'final' ? view.state : view.kind}>
        {view.kind === 'loading' && <p className="text-[length:var(--font-body)] text-[var(--text-secondary)]">{t('devices.approveServer.loading')}</p>}
        {view.kind === 'failed' && (
          <>
            <p className="text-[length:var(--font-body)] text-[var(--text-primary)]" role="alert">{view.message}</p>
            <Button variant="secondary" size="lg" onClick={onDone}>{t('devices.approveServer.close')}</Button>
          </>
        )}
        {view.kind === 'request' && <RequestBody view={view} onDecide={(approve) => decide(view.request, approve)} />}
        {view.kind === 'final' && (
          <>
            <h2 className="text-[length:var(--font-title)] font-semibold text-[var(--text-primary)]">{t(`devices.approveServer.final.${view.state}.title`)}</h2>
            <p className="text-[length:var(--font-body)] leading-relaxed text-[var(--text-secondary)]">
              {view.state === 'refused'
                ? <MachineLimitNotice refusal={view.refusal} />
                : t(`devices.approveServer.final.${view.state}.body`, { host: view.hostname ?? t('devices.approveServer.thisMachine') })}
            </p>
            <Button variant="secondary" size="lg" onClick={onDone} data-testid="server-login-approve-close">{t('devices.approveServer.close')}</Button>
          </>
        )}
      </div>
    </Sheet>
  )
}

function RequestBody({
  view,
  onDecide,
}: {
  view: Extract<View, { kind: 'request' }>
  onDecide: (approve: boolean) => void
}) {
  const { t } = useTranslation('settings')
  const { machine } = view.request
  const host = machine.hostname ?? t('devices.approveServer.thisMachine')
  const rows: Array<[string, string | null]> = [
    [t('devices.approveServer.system'), [PLATFORM_NAMES[machine.platform?.toLowerCase() ?? ''] ?? machine.platform, machine.arch].filter(Boolean).join(' · ') || null],
    [t('devices.approveServer.user'), machine.user],
    [t('devices.approveServer.from'), view.request.requesterIp],
    [t('devices.approveServer.code'), view.request.code],
  ]
  return (
    <>
      <h2 className="text-[length:var(--font-title)] font-semibold text-[var(--text-primary)] [overflow-wrap:anywhere]">
        {t('devices.approveServer.ask', { host })}
      </h2>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-[var(--radius-control)] border border-[var(--border-color)] bg-[var(--bg-elevated)] px-4 py-3 text-[length:var(--font-body)]">
        {rows.filter(([, value]) => value).map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-[var(--text-secondary)]">{label}</dt>
            <dd className="text-[var(--text-primary)] [overflow-wrap:anywhere]">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="text-[length:var(--font-body)] leading-relaxed text-[var(--text-secondary)]">{t('devices.approveServer.warning')}</p>
      {view.error && <p className="text-[length:var(--font-body)] text-[var(--danger)]" role="alert">{view.error}</p>}
      <Button variant="primary" size="lg" disabled={view.busy} onClick={() => onDecide(true)} data-testid="server-login-approve-allow">
        {t('devices.approveServer.allow', { host })}
      </Button>
      <Button variant="ghost" size="lg" disabled={view.busy} onClick={() => onDecide(false)} data-testid="server-login-approve-deny">
        {t('devices.approveServer.deny')}
      </Button>
    </>
  )
}
