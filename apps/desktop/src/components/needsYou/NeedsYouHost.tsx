import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { createPortal } from 'react-dom'
import { useMobileShell } from '@/hooks/useMobileShell'
import { useChatStore } from '@/store/chatContext'
import { useTimelineSession } from '@/mobile/agent-watch/use-timeline-session'
import { SettlementCard } from '@/mobile/agent-watch/TimelineView'
import { assistantTimelineClient } from '../assistant/assistantTimelineClient'
import { AgentNeedsUserGlyph } from '../AgentNeedsUserGlyph'
import { Button } from '../ui/Button'
import { Sheet } from '../ui/Sheet'
import { PaneHeader } from '../ui/Pane'
import { closeInShell } from '@/session/renderer/features/extensions/install-consent'
import { appInstallAskOf } from '@/session/shared/extensions/host-actions'
import { observer } from 'mobx-react-lite'
import { followLink } from '@/lib/guguLinks'
import { readPhoneAppView, onPhoneAppState } from '../appSlot/phoneAppState'
import { sessionPagesOnScreen } from '@/session/renderer/app/sessions-on-screen'
import { getSessionView } from '@/session/renderer/features/sessions/stores/session-selectors'
import { isEmbedVisible, subscribeEmbedVisibility } from '@/session/renderer/lib/portal-container'
import { useNeedsYouTasks, type NeedsYouTask } from './useNeedsYouTasks'
import '@/i18n/registerMobileWorkspaceCatalog'
import '@/mobile/agent-watch/agent-watch.css'

function taskKey(task: NeedsYouTask): string {
  return `${task.deviceId}/${task.session.conversationId}`
}

/** One actionable entrance to the existing pending settlements, over every shell page. */
export const NeedsYouHost = observer(function NeedsYouHost() {
  const { t } = useTranslation()
  const mobile = useMobileShell()
  const { tasks: waiting, error } = useNeedsYouTasks()
  const phone = useSyncExternalStore(onPhoneAppState, readPhoneAppView)
  const embedded = useSyncExternalStore(subscribeEmbedVisibility, isEmbedVisible)
  // Reuse the actual task route and active pane entries. A file/App tab has no approval card.
  const shownSessions = mobile
    ? phone.panes.some(pane => pane.activeTab?.kind === 'session') ? [phone.activeSessionId] : []
    : embedded ? sessionPagesOnScreen().filter(page => getSessionView(page.projectId, page.sessionId)?.paneLayout.groups.some(({ pane }) => {
      const entry = pane.activeEntry
      return (entry?.kind === 'session' || entry?.kind === 'acp-chat') && (entry.state as { sessionId?: string }).sessionId === page.sessionId
    })).map(page => page.sessionId) : []
  const tasks = waiting.filter(task => !(task.session.supported && shownSessions.includes(task.session.conversationId)))
  const { identitiesById } = useChatStore('identitiesById')
  const [opened, setOpened] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const task = tasks.find(task => taskKey(task) === selected) ?? (tasks.length === 1 ? tasks[0] : undefined)
  const shown = opened && tasks.length > 0
  // Closing after the last wait also resets the next visit, without retaining a hidden dialog.
  if (opened && tasks.length === 0) setOpened(false)
  return createPortal(<>
    {tasks.length > 0 && <div role="status" aria-live="polite" className="fixed right-4 bottom-4 z-[var(--z-settings-modal)] data-[mobile]:bottom-[calc(72px+env(safe-area-inset-bottom))]" data-mobile={mobile || undefined}>
      <Button data-testid="needs-you-trigger" onClick={() => setOpened(true)} aria-haspopup="dialog" aria-expanded={shown}>
        <AgentNeedsUserGlyph size={16} />{t('needsYou.count', { count: tasks.length })}
      </Button>
    </div>}
    {shown && <Sheet fullScreenMobile testId="needs-you-sheet" ariaLabel={t('needsYou.title')} onClose={() => setOpened(false)} zIndex="var(--z-settings-modal)" desktopWidth="520px">
      <PaneHeader title={t('needsYou.title')} mobile={mobile} divider actions={<Button variant="ghost" onClick={() => setOpened(false)}>{t('dialog.close')}</Button>} />
      <div className="flex min-h-0 flex-col gap-3 overflow-auto !p-4">
        {error && <p role="alert">{error}</p>}
        {tasks.map(item => <Button key={taskKey(item)} variant={taskKey(item) === selected ? 'secondary' : 'ghost'}
          data-testid="needs-you-task" onClick={() => setSelected(taskKey(item))}>
          <span className="flex min-w-0 flex-1 flex-col text-left"><span className="truncate">{identitiesById[item.session.agent?.userId ?? '']?.display_name || item.session.title}</span>
            <span className="text-[length:var(--font-caption)] text-[var(--text-secondary)]">{item.machine}</span></span>
        </Button>)}
        {task && <PendingTask key={taskKey(task)} task={task} onOpenTask={() => { setOpened(false); followLink({ kind: 'session', sessionId: task.session.conversationId }) }} />}
      </div>
    </Sheet>}
  </>, document.body)
})

function PendingTask({ task, onOpenTask }: { task: NeedsYouTask; onOpenTask: () => void }) {
  const { t } = useTranslation()
  const mobile = useMobileShell()
  const read = useTimelineSession(assistantTimelineClient(task.local), mobile ? 'mobile' : 'desktop', task.deviceId, task.session.conversationId, true)
  const ready = read.phase === 'ready' && read.link === 'ok'
  const previousInstalls = useRef<string[]>([])
  // The host's timeout and answers on another device withdraw the same permission sheet here.
  useEffect(() => {
    const installs = ready ? Object.values(read.timeline.settlements).filter(item => item.state === 'pending' && appInstallAskOf(item.host)).map(item => item.itemId) : []
    for (const id of previousInstalls.current) if (!installs.includes(id)) closeInShell(id)
    previousInstalls.current = installs
  }, [ready, read.timeline.settlements])
  useEffect(() => () => { for (const id of previousInstalls.current) closeInShell(id) }, [])
  const pending = Object.values(read.timeline.settlements).filter(item => item.state === 'pending')
  return <section data-testid="needs-you-pending" className="flex flex-col gap-3">
    {(read.error || read.actionError) && <p role="alert">{read.error || read.actionError}</p>}
    {!ready && <p role="status">{t('needsYou.loading')}</p>}
    {ready && pending.map(settlement => <SettlementCard key={settlement.itemId} settlement={settlement} runtime={task.session.runtime}
      machine={task.local ? undefined : task.machine} busy={read.respondingItemId === settlement.itemId}
      onRespond={input => { void read.respond(input).catch(() => undefined) }} />)}
    <Button variant="ghost" data-testid="needs-you-open-page" onClick={onOpenTask}>{t('needsYou.openPage')}</Button>
  </section>
}
