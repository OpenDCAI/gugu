import { AlertCircle, Info, TriangleAlert } from '@/lib/icons'
import { observer } from 'mobx-react-lite';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { browserDiagnosticsStore } from './browser-diagnostics-store';

export const BrowserDiagnosticsPanel = observer(function BrowserDiagnosticsPanel({
  browserId,
}: {
  browserId: string;
}) {
  const { translate } = useSessionMessages();
  const entries = browserDiagnosticsStore.entriesForBrowser(browserId).slice(-50).reverse();

  if (entries.length === 0) return null;

  return (
    <div className="h-32 shrink-0 overflow-hidden border-t border-border bg-background-secondary">
      <div className="flex h-8 items-center justify-between px-3 text-xs text-foreground-muted">
        <span>{translate('browser.diagnostics')}</span>
        <button
          type="button"
          className="rounded-sm px-2 py-1 hover:bg-row-hover"
          onClick={() => browserDiagnosticsStore.clearBrowser(browserId)}
        >
          {translate('browser.clearDiagnostics')}
        </button>
      </div>
      <div className="h-24 overflow-auto px-2 pb-2">
        {entries.map((entry) => (
          <div
            key={entry.id}
            className="hover:bg-row-hover grid grid-cols-[16px_72px_1fr] items-start gap-2 py-1 text-xs"
          >
            <DiagnosticIcon level={entry.level} />
            <span className="text-foreground-muted">{entry.source}</span>
            <div className="min-w-0">
              <div className="truncate text-foreground">{entry.message}</div>
              {entry.url && <div className="truncate text-foreground-muted">{entry.url}</div>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
});

function DiagnosticIcon({ level }: { level: 'info' | 'warning' | 'error' }) {
  if (level === 'error') return <AlertCircle className="text-foreground-destructive mt-0.5 size-3.5" />;
  if (level === 'warning') {
    // 原生 yellow-500 → 家族色,与同函数上一支 error 分支(text-foreground-destructive)同源。
    return <TriangleAlert className="mt-0.5 size-3.5 text-foreground-warning" />;
  }
  return <Info className="mt-0.5 size-3.5 text-foreground-muted" />;
}
