import { Button } from '@/components/ui/Button'
import { translateSessionMessage } from '@/session/renderer/localization/locale-store'
import { AgentWatchNote } from './AgentWatchChrome'

export function SessionLoadFailure({ title, detail, reloadLabel, onReload, recovery }: {
  title: string; detail: string; reloadLabel: string; onReload(): void
  recovery: { canStartFresh: boolean; busy: boolean; startFresh(): Promise<void> }
}) {
  return <AgentWatchNote title={title} detail={detail} tone="danger" testId="agent-watch-timeline-error">
    <div className="flex gap-2">
      <Button variant="secondary" size="lg" className="min-w-0 flex-1 whitespace-normal" onClick={onReload} disabled={recovery.busy}>{reloadLabel}</Button>
      {recovery.canStartFresh ? <Button variant="secondary" size="lg" className="min-w-0 flex-1 whitespace-normal" onClick={() => { void recovery.startFresh() }} disabled={recovery.busy}>
        {translateSessionMessage('transcript.condition.startFresh')}
      </Button> : null}
    </div>
  </AgentWatchNote>
}
