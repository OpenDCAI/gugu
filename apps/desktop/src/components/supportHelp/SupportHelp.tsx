import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { queryClient } from '@/session/renderer/lib/query-client'
import { useAuth } from '@/store/auth'
import { useChatStore } from '@/store/chatContext'
import { UI_EVENTS } from '@/lib/uiEvents'
import { Button } from '../ui/Button'
import { MenuItem, MenuSeparator } from '../ui/Menu'
import { Sheet } from '../ui/Sheet'
import { fetchSupportHelp, joinSupportHelp } from './api'
import { isSupportHelpInfo, type HelpInfo, type SupportHelpInfo } from './contract'
import './catalog'

export function SupportHelp({ helpOpen, generation, onCloseMenu, onOpenGroup, children }: {
  helpOpen: boolean; generation: number; onCloseMenu: () => void; onOpenGroup: (id: string) => void
  children: (entry: ReactNode) => ReactNode
}) {
  const { t } = useTranslation('supportHelp')
  const { user } = useAuth()
  const [dialog, setDialog] = useState(false)
  // Each menu opening gets a new query, so cached release flags cannot flash before revalidation.
  const key = ['support-help', user?.id ?? null, generation]
  const query = useQuery({
    queryKey: key, queryFn: ({ signal }) => fetchSupportHelp(signal), enabled: helpOpen || dialog,
    staleTime: 0, gcTime: 0, refetchOnMount: 'always', refetchInterval: 30_000, retry: false,
  }, queryClient)
  const snapshot = query.data
  const info = isSupportHelpInfo(snapshot) ? snapshot : null
  // Server revocation closes the surface and stops polling when the menu is also closed.
  useEffect(() => { if (query.isSuccess && !query.data.support_help_entry_enabled) setDialog(false) }, [query.data, query.isSuccess])
  const visible = info !== null && !query.isError
  return <>
    {children(visible ? <><MenuItem onClick={() => { setDialog(true); onCloseMenu() }}>{t('entry')}</MenuItem><MenuSeparator /></> : null)}
    {dialog && info && <SupportHelpDialog info={info} failed={query.isError} refreshing={query.isFetching}
      refresh={() => { void query.refetch() }} onClose={() => setDialog(false)} onOpenGroup={onOpenGroup}
      onInfo={(next) => { queryClient.setQueryData(key, next); if (!next.support_help_entry_enabled) setDialog(false) }} />}
  </>
}

function SupportHelpDialog({ info, failed, refreshing, refresh, onClose, onOpenGroup, onInfo }: {
  info: SupportHelpInfo; failed: boolean; refreshing: boolean; refresh: () => void; onClose: () => void
  onOpenGroup: (id: string) => void; onInfo: (info: HelpInfo) => void
}) {
  const { t } = useTranslation('supportHelp')
  const { user } = useAuth()
  const { refreshChats } = useChatStore('refreshChats')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<'network' | 'changed' | 'login' | null>(null)
  const inFlight = useRef(false)
  const group = info.group
  const pending = !group.is_member && group.join_request_status === 'pending'
  const available = group.is_member || group.availability === 'available'
  async function enter() {
    if (inFlight.current) return
    inFlight.current = true; setBusy(true); setNotice(null)
    try {
      // Opening existing membership also revalidates the gate and configuration.
      const result = await joinSupportHelp(info)
      if (result.status === 'joined') {
        await refreshChats()
        onOpenGroup(result.chat_id)
        onClose()
      } else {
        onInfo(result.info)
        if (result.status === 'config_changed') setNotice('changed')
        if (result.status === 'login_required') setNotice('login')
      }
    } catch { setNotice('network') }
    finally { inFlight.current = false; setBusy(false) }
  }
  const action = group.is_member ? 'open' : group.join_mode === 'approval' ? 'request' : 'join'
  return <Sheet onClose={onClose} ariaLabel={t('title')} desktopWidth="min(420px, 100%)" testId="support-help-dialog">
    <div className="p-5 space-y-4 text-[length:var(--font-body)] text-[var(--text-primary)]">
      <div>
        <h2 className="m-0 text-[length:var(--font-title)] font-semibold">{t('title')}</h2>
        <p className="mt-3 mb-1 font-medium break-words">{group.name}</p>
        <p className="m-0 text-[length:var(--font-caption)] text-[var(--text-secondary)]">{t('number', { number: group.public_id })}</p>
      </div>
      <div className="space-y-2">
        <p className="m-0">{t('visibility')}</p>
        <p className="m-0 text-[var(--text-secondary)]">{t('privateGuidance')}</p>
      </div>
      {info.duty_human && <p className="m-0 text-[var(--text-secondary)]">{t('duty', { name: info.duty_human.display_name })}</p>}
      {info.assistants.length > 0 && <p className="m-0 text-[var(--text-secondary)]">{t('assistants', { names: info.assistants.map((agent) => agent.display_name).join('、') })}</p>}
      <div role="status" aria-live="polite" className="text-[var(--text-secondary)]">
        {!user ? t('login') : pending ? t('pending') : !available ? t(`availability.${group.availability}`) : null}
        {(failed || notice) && <p className="mt-2 mb-0" role="alert">{t(failed ? 'network' : notice!)}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" disabled={!user || pending || !available || busy || failed || refreshing} onClick={() => { void enter() }}>{busy ? t('working') : t(action)}</Button>
        {(failed || notice === 'network') && <Button disabled={refreshing || busy} onClick={() => { setNotice(null); refresh() }}>{t('retry')}</Button>}
        {user && <Button variant="ghost" onClick={() => { onClose(); window.dispatchEvent(new CustomEvent(UI_EVENTS.sessionpageOpenFeedback)) }}>{t('feedback')}</Button>}
        <Button variant="ghost" onClick={() => window.open('https://gugu.nextmind.space/zh/contact.html', '_blank', 'noopener,noreferrer')}>{t('website')}</Button>
      </div>
    </div>
  </Sheet>
}
