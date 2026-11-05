import { useEffect, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { conversationLink } from '@gugu/core/shared/ui/guguLink'
import { locateFindRange, paintFindHighlight } from '@gugu/session-chat-ui/find-highlight'
import { useCommandProvider } from '@renderer/lib/commands/use-command-provider'
import { reopenGlobalSearch, updateSearchSession, useSearchSession } from '@renderer/features/global-search/search-session'
import { followLink } from '@/lib/guguLinks'
import { isChatSearchTarget } from '@/lib/chatSearchTarget'
import { ChevronDown, ChevronUp, X } from '@/lib/icons'
import { Button } from '../ui/Button'
import { IconButton } from '../ui/IconButton'

/** How long the searched words stay painted on the message the trail landed on (its row flashes for the same reason). */
const PAINT_MS = 2400

/**
 * The search a conversation was opened from, over its messages: 「3/18」, previous / next (⌘G), 「结果」 to reopen the
 * panel as it was left, × to put the search away. Shown on the conversation that holds the current hit; stepping to a
 * hit in another conversation opens that one. The hit's words are painted on its message once it is on screen.
 */
export function SearchTrailBar({ chatId, surface, enabled }: { chatId: string | null; surface: RefObject<HTMLElement | null>; enabled: boolean }) {
  const { t } = useTranslation('messaging')
  const { trail } = useSearchSession()
  const hit = trail?.hits[trail.index]
  const shown = !!trail && !!hit && hit.chatId === chatId
  const step = (direction: 1 | -1) => {
    if (!trail || !trail.hits.length) return
    const index = (trail.index + direction + trail.hits.length) % trail.hits.length
    const next = trail.hits[index]!
    updateSearchSession({ trail: { ...trail, index } })
    followLink(conversationLink(next.chatId, next.messageId))
  }
  useCommandProvider({
    scopeId: 'app',
    isActive: (element) => enabled && shown && !!chatId && isChatSearchTarget(surface.current, chatId, element),
    getCommands: () => [{ id: 'app.findNext', hideFromPalette: true, execute: () => step(1) }],
  })

  const messageId = shown ? hit.messageId : null
  const query = trail?.query ?? ''
  useEffect(() => {
    if (!messageId || !query || !enabled) return
    const owner = {}
    let frame = 0, tries = 0
    const timer = setTimeout(() => paintFindHighlight(document, owner, null), PAINT_MS)
    const paint = () => {
      const row = surface.current?.querySelector<HTMLElement>(`[data-msg-id="${CSS.escape(messageId)}"]`)
      const range = row ? locateFindRange(row, query, 0) : null
      if (range) paintFindHighlight(document, owner, range)
      else if (++tries < 120) frame = requestAnimationFrame(paint)
    }
    frame = requestAnimationFrame(paint)
    return () => { cancelAnimationFrame(frame); clearTimeout(timer); paintFindHighlight(document, owner, null) }
  }, [messageId, query, enabled, surface, trail?.index])

  if (!shown) return null
  return (
    <div data-testid="search-trail-bar" className="window-no-drag-region flex shrink-0 items-center gap-1 border-b border-[var(--border)] px-3 py-1 text-[length:var(--font-body)]">
      <span className="min-w-0 flex-1 truncate text-[var(--text-secondary)]">
        {query ? t('searchTrail.position', { query, index: trail.index + 1, total: trail.hits.length }) : t('searchTrail.positionNoWords', { index: trail.index + 1, total: trail.hits.length })}
      </span>
      <IconButton size="sm" aria-label={t('searchTrail.previous')} title={t('searchTrail.previous')} onClick={() => step(-1)}><ChevronUp /></IconButton>
      <IconButton size="sm" aria-label={t('searchTrail.next')} title={t('searchTrail.next')} onClick={() => step(1)}><ChevronDown /></IconButton>
      <Button variant="ghost" size="sm" data-testid="search-trail-results" onClick={reopenGlobalSearch}>{t('searchTrail.results')}</Button>
      <IconButton size="sm" aria-label={t('searchTrail.close')} title={t('searchTrail.close')} onClick={() => updateSearchSession({ trail: null })}><X /></IconButton>
    </div>
  )
}
