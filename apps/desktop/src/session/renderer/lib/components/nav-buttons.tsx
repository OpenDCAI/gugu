import { ArrowLeft, ArrowRight } from '@/lib/icons'
import { observer } from 'mobx-react-lite';
import { getSessionView } from '@renderer/features/sessions/stores/session-selectors';
import { appState } from '@renderer/lib/stores/app-state';
import type { HistoryEntry } from '@renderer/lib/stores/navigation-history-store';
import { Button } from '@renderer/lib/ui/button';
import { BoundShortcut } from '@renderer/lib/ui/shortcut';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';

export function applyHistoryEntry(entry: HistoryEntry): void {
  if (entry.kind === 'view') {
    appState.navigation._applyNavigation(entry.viewId, entry.params);
  } else {
    appState.navigation._applyNavigation('session', {
      projectId: entry.projectId,
      sessionId: entry.sessionId,
    });
    getSessionView(entry.projectId, entry.sessionId)?.activePane.setActiveTab(entry.tabId);
  }
}

export function navigateBack(canGoBack: boolean): void {
  if (!canGoBack) return;
  appState.history.back(applyHistoryEntry);
}

export function navigateForward(canGoForward: boolean): void {
  if (!canGoForward) return;
  appState.history.forward(applyHistoryEntry);
}

export const NavButtons = observer(function NavButtons() {
  const { canGoBack, canGoForward } = appState.history;
  return (
    <div className="flex items-center gap-0.5 [-webkit-app-region:no-drag]">
      <Tooltip>
        <TooltipTrigger render={
          <Button
            variant="ghost"
            size="sm"
            className="size-7 p-0 aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
            aria-disabled={!canGoBack || undefined}
            aria-label="Go Back"
            onClick={() => navigateBack(canGoBack)}
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
        } />
        <TooltipContent>
          Go Back
          <BoundShortcut settingsKey="navigateBack" variant="keycaps" />
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger render={
          <Button
            variant="ghost"
            size="sm"
            className="size-7 p-0 aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
            aria-disabled={!canGoForward || undefined}
            aria-label="Go Forward"
            onClick={() => navigateForward(canGoForward)}
          >
            <ArrowRight className="h-4 w-4" />
          </Button>
        } />
        <TooltipContent>
          Go Forward
          <BoundShortcut settingsKey="navigateForward" variant="keycaps" />
        </TooltipContent>
      </Tooltip>
    </div>
  );
});
