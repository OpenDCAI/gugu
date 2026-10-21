import { translateSessionMessage } from '../../session/renderer/localization/locale-store'
import { Button } from '../ui/Button'

/**
 * What an App's page said went wrong (`reportError`, or an error it did not catch): a red dot and 「这个 App 出错了 · 详情」
 * (`AppErrorMark`), and, pressed, the whole of it (`AppErrorDetails`). One mark wherever an App's page is drawn — a chat's
 * panel, the App's own page (125 10-06: 「处处一样」) — so the person reads it the same way everywhere.
 */
export function AppErrorMark({ error, onToggle, testId }: { error: string; onToggle: () => void; testId: string }) {
  return (
    // Shrinks to its dot in a narrow slot: what sits beside it (close, full) never goes off the edge.
    <Button size="sm" variant="ghost" className="min-w-0" data-testid={testId} onClick={onToggle} title={error}>
      <span className="inline-block size-2 shrink-0 rounded-full bg-[var(--text-error)]" />
      <span className="truncate">
        {translateSessionMessage('extensions.appError')} · {translateSessionMessage('extensions.appErrorDetails')}
      </span>
    </Button>
  )
}

export function AppErrorDetails({ error, testId }: { error: string; testId: string }) {
  return (
    <div
      data-testid={testId}
      className="whitespace-pre-wrap break-words border-b border-[var(--border)] !px-3 !py-2 text-[length:var(--font-caption)] text-[var(--text-error)]"
    >
      {error}
    </div>
  )
}
