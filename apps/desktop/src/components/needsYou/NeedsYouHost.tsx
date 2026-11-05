import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { createPortal } from 'react-dom'
import { observer } from 'mobx-react-lite'
import type { AgentAttention } from '@gugu/core/shared/agentStatus'
import { useMobileShell } from '@/hooks/useMobileShell'
import { sessionPresentation } from '@/mobile/agent-watch/watch-status'
import { followLink } from '@/lib/guguLinks'
import { Bell } from '@/lib/icons'
import { installShellSlots, readShellSlots } from '@/lib/shellSlots'
import { setSidebarNotificationsOpen, useSidebarNotificationsOpen } from '@/lib/sidebarChatsBridge'
import { Button } from '../ui/Button'
import { Chip } from '../ui/Chip'
import { IconButton } from '../ui/IconButton'
import { SectionLabel } from '../ui/SectionLabel'
import { rowKeyActivate } from '../contacts/contactsPanelStyles'
import { messageSeen, MESSAGE_SEEN_THRESHOLDS } from '../chat/messageSeen'
import { NOTIFICATION_LIST_SLOT_PREFIX, NOTIFICATION_TOGGLE_SLOT_PREFIX } from './NotificationSlot'
import { NeedsYouTaskRow } from './NeedsYouTaskRow'
import { markNeedsYouTaskSeen, useNeedsYouTasks, type NeedsYouTask } from './useNeedsYouTasks'

installShellSlots()
const EMPTY_SLOTS: ReadonlyMap<string, HTMLElement> = new Map()
const NOTHING_KEPT: ReadonlyMap<string, NeedsYouTask> = new Map()
const taskKey = (task: NeedsYouTask) => `${task.deviceId}/${task.session.conversationId}`
const byLatest = (a: NeedsYouTask, b: NeedsYouTask) => (Date.parse(b.session.lastInteractedAt ?? '') || 0) - (Date.parse(a.session.lastInteractedAt ?? '') || 0)

/** The failures this open panel has listed; returns `kept` itself when nothing new appeared. */
function keepListed(kept: ReadonlyMap<string, NeedsYouTask>, failures: NeedsYouTask[]): ReadonlyMap<string, NeedsYouTask> {
  const added = failures.filter(task => !kept.has(taskKey(task)))
  return added.length ? new Map([...kept, ...added.map(task => [taskKey(task), task] as const)]) : kept
}

/** One account-owned notification list, shared by the desktop workspace and phone Messages header. */
export const NeedsYouHost = observer(function NeedsYouHost({ onAttentionChange }: { onAttentionChange?: (attention: AgentAttention) => void }) {
  const { t } = useTranslation()
  const mobile = useMobileShell()
  const { tasks, attention, error } = useNeedsYouTasks()
  const open = useSidebarNotificationsOpen()
  useEffect(() => { onAttentionChange?.(attention) }, [onAttentionChange, attention])
  const slots = readShellSlots()
  const entries = useSyncExternalStore(listener => slots?.subscribeSlots(listener) ?? (() => undefined), () => slots?.getSlots() ?? EMPTY_SLOTS)
  const [marking, setMarking] = useState(0)
  const [readError, setReadError] = useState<string | null>(null)
  useEffect(() => { setReadError(null) }, [open])
  const markRead = useCallback(async (items: NeedsYouTask[]) => {
    setMarking(count => count + 1)
    const results = await Promise.allSettled(items.map(markNeedsYouTaskSeen))
    const errors = results.flatMap(result => result.status === 'rejected' ? [String(result.reason instanceof Error ? result.reason.message : result.reason)] : [])
    if (errors.length) setReadError(previous => [previous, ...errors].filter(Boolean).join('\n'))
    setMarking(count => count - 1)
  }, [])
  const failures = tasks.filter(task => sessionPresentation(task.session, true)?.tone === 'error')
  // A visible failure row is read at once (#1616) and read failures leave `tasks` (#1654), so the row would vanish as it
  // appears. While the panel is open it keeps listing the failures it has shown; the count still drops, and closing the
  // panel applies the read filter.
  const [kept, setKept] = useState(NOTHING_KEPT)
  const nextKept = open ? keepListed(kept, failures) : NOTHING_KEPT
  if (nextKept !== kept) setKept(nextKept)
  const live = new Set(tasks.map(taskKey))
  const listed = [...tasks, ...[...nextKept.values()].filter(task => !live.has(taskKey(task)))].sort(byLatest)
  const title = t('settings.general.notifications', { ns: 'main' })
  return <>{[...entries].map(([key, element]) => {
    if (key.startsWith(NOTIFICATION_TOGGLE_SLOT_PREFIX)) return createPortal(
      <span className="relative inline-flex">
        <IconButton size={mobile ? 'md' : 'sm'} aria-label={title} title={title} aria-pressed={open} on={open} data-testid="notification-toggle" onClick={() => setSidebarNotificationsOpen(!open)}>
          <Bell />
        </IconButton>
        {tasks.length > 0 && <Chip tone="danger" shape="count" className="pointer-events-none absolute -right-1 -top-1" data-testid="notification-count">{tasks.length > 99 ? '99+' : tasks.length}</Chip>}
      </span>, element, key)
    if (!key.startsWith(NOTIFICATION_LIST_SLOT_PREFIX) || !open || slots?.getSlotLabel?.(key) !== 'active') return null
    return createPortal(<>
      <div className="flex shrink-0 items-center justify-between gap-2 px-4 py-2">
        <SectionLabel>{title}</SectionLabel>
        {failures.length > 0 && <Button size="sm" variant="ghost" data-testid="notification-mark-all-read" disabled={marking > 0} onClick={() => { void markRead(failures) }}>{t('chatList.markAllRead', { ns: 'messaging' })}</Button>}
      </div>
      <div data-testid="notification-list" data-notification-scroll="" role="listbox" aria-label={title} className="min-h-0 flex-1 overflow-auto px-2 pb-4">
        {error && <p role="alert">{error}</p>}
        {readError && <p role="alert">{readError}</p>}
        {listed.map(task => <NotificationTaskRow key={taskKey(task)} task={task} mobile={mobile} onRead={markRead} />)}
      </div>
    </>, element, key)
  })}</>
})

const NotificationTaskRow = observer(function NotificationTaskRow({ task, mobile, onRead }: { task: NeedsYouTask; mobile: boolean; onRead: (items: NeedsYouTask[]) => Promise<void> }) {
  const ref = useRef<HTMLDivElement>(null)
  const latest = useRef({ task, onRead })
  latest.current = { task, onRead }
  const failure = sessionPresentation(task.session, true)?.tone === 'error'
  const { deviceId, local, phoneHost, session: { conversationId, unseen } } = task
  useEffect(() => {
    const node = ref.current
    if (!node || !failure) return
    let seen = false
    let entry: IntersectionObserverEntry | undefined
    const acknowledge = () => {
      if (!seen && document.visibilityState !== 'hidden' && (!entry || messageSeen(entry))) {
        seen = true
        void latest.current.onRead([latest.current.task])
      }
    }
    if (typeof IntersectionObserver === 'undefined') { acknowledge(); return }
    // The viewport includes clipping above the list (collapsed sidebar and retained surfaces).
    const observer = new IntersectionObserver(entries => {
      entry = entries.find(entry => entry.target === node)
      if (entry) acknowledge()
    }, { threshold: [...MESSAGE_SEEN_THRESHOLDS] })
    const onVisibility = () => { if (entry) acknowledge() }
    observer.observe(node)
    document.addEventListener('visibilitychange', onVisibility)
    return () => { observer.disconnect(); document.removeEventListener('visibilitychange', onVisibility) }
  }, [failure, deviceId, conversationId, local, phoneHost, unseen])
  const openTask = () => followLink({ kind: 'session', sessionId: conversationId, deviceId })
  return <NeedsYouTaskRow ref={ref} task={task} mobile={mobile} onClick={openTask} onKeyDown={rowKeyActivate(openTask)} />
})
