import './first-run-hints.css'
import '../../i18n/registerAssistantCatalog'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useMobileShell } from '@/hooks/useMobileShell'
import { allFirstRunHintsDismissed, dismissFirstRunHints, readFirstRunHints, type FirstRunHintId } from '@/lib/firstRunHints'
import { Button } from '../ui/Button'
import { Popover } from '../ui/Popover'
import { HINT_ENTRIES, useFirstRunHintTargets } from './firstRunHintTargets'

/** One quiet, contextual hint at a time. Account reads/writes must succeed before claiming progress. */
export function FirstRunHints({ userId }: { userId: string }) {
  const { t } = useTranslation('assistant')
  const device = useMobileShell() ? 'phone' : 'desktop'
  const client = useQueryClient()
  const queryKey = ['first-run-hints', userId]
  const progress = useQuery({ queryKey, queryFn: () => readFirstRunHints(userId), retry: false })
  const shown = HINT_ENTRIES[device].map((entry) => entry.id)
  const targets = useFirstRunHintTargets(device, progress.isError || (progress.data != null && !allFirstRunHintsDismissed(progress.data, shown)))
  const [pending, setPending] = useState<FirstRunHintId[]>([])
  // Retire the current encounter, not every hint currently on screen in a chain.
  // Another hint can appear when its entry is encountered on a later page/visit.
  const suppressed = useRef(new Set<HTMLElement>())
  for (const anchor of suppressed.current) if (!targets.some((target) => target.anchor === anchor)) suppressed.current.delete(anchor)
  const save = useMutation({
    mutationFn: (ids: readonly FirstRunHintId[]) => dismissFirstRunHints(userId, ids),
    onSuccess: (next) => {
      client.setQueryData(queryKey, next)
      setPending((ids) => ids.filter((id) => !next.dismissed.includes(id)))
    },
  })
  const unsaved = pending.filter((id) => !progress.data?.dismissed.includes(id))
  useEffect(() => {
    if (progress.isSuccess && progress.data && unsaved.length && !save.isPending && !save.isError) save.mutate(unsaved)
  }, [progress.isSuccess, progress.data, unsaved, save])

  const retire = (id: FirstRunHintId) => {
    targets.forEach((target) => suppressed.current.add(target.anchor))
    setPending((ids) => ids.includes(id) ? ids : [...ids, id])
  }
  // Capture use even while the account read is pending, and before a pushed page removes its entry.
  useEffect(() => {
    if (progress.isSuccess && (!progress.data || allFirstRunHintsDismissed(progress.data, shown))) return
    const used = (event: Event) => {
      const element = event.target instanceof Element ? event.target : null
      if (!element || element.closest('[disabled], [aria-disabled="true"]')) return
      if (event instanceof KeyboardEvent && event.key !== 'Enter' && event.key !== ' ' && !(element.closest('[role="tab"]') && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key))) return
      const entry = HINT_ENTRIES[device].find((item) => element.closest(item.use))
      if (entry) retire(entry.id)
    }
    document.addEventListener('click', used, true)
    document.addEventListener('keydown', used, true)
    return () => {
      document.removeEventListener('click', used, true)
      document.removeEventListener('keydown', used, true)
    }
  })

  const failed = progress.isError || save.isError
  const confirmed = progress.data
  const target = failed ? targets[0] : confirmed ? targets.find((item) => !confirmed.dismissed.includes(item.id) && !pending.includes(item.id) && !suppressed.current.has(item.anchor)) : null
  if (!target) return null
  const retry = () => {
    if (progress.isError) void progress.refetch()
    else save.mutate(unsaved)
  }
  const label = t(failed ? progress.isError ? 'hints.unreadable' : 'hints.saveFailed' : `hints.${device}.${target.id}`)
  const note = <>
    <p role={failed ? 'alert' : undefined}>{label}</p>
    <Button variant="ghost" size="sm" onClick={failed ? retry : () => retire(target.id)} disabled={progress.isFetching || save.isPending}>
      {t(failed ? 'hints.retry' : 'hints.dismiss')}
    </Button>
  </>
  const testId = failed ? 'first-run-hint-error' : `first-run-hint-${target.id}`
  if (target.space) return createPortal(
    <aside className="first-run-hint first-run-hint-inline" aria-label={label} data-testid={testId}>{note}</aside>, target.space,
  )
  if (device !== 'desktop' || (target.id !== 'assistant' && target.id !== 'tour')) return null
  return (
    <Popover.Root open modal={false} onOpenChange={(open) => { if (!open && !failed) retire(target.id) }}>
      <Popover.Portal>
        <Popover.Positioner anchor={target.anchor} side="right" align="start" sideOffset={8} collisionPadding={16}>
          <Popover.Popup className="first-run-hint" initialFocus={false} finalFocus={false} aria-label={label} data-testid={testId}>{note}</Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}
