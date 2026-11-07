import { useContext, type ReactNode } from 'react';
import { observer } from 'mobx-react-lite';
import { ArrowLeft, Eye, Pencil } from '@/lib/icons';
import { PaneContext } from '@renderer/features/tabs/pane-context';
import type { TabHost } from '@renderer/features/tabs/core/tab-host';
import { Button } from '@renderer/lib/ui/button';
import { panelHeaderBarClass } from '@renderer/lib/ui/panel-header-bar';
import { useSessionMessages } from '@renderer/localization/use-session-messages';

/**
 * One file toolbar for working-copy files and the host's read-only chat-file preview. Left to right: back (with its words
 * when there is room; none when there is nowhere to go, as with the conversation beside it), the file's name, the mode, ⋯ — the order the folder App's own head keeps too (viewer-unify).
 * The mode is one outlined toggle that shows where a press goes: ✎ while reading, 👁 while editing (owner 11-06).
 * Narrowing, it gives way in that order: back's words; the name last.
 */
export const FileToolbar = observer(function FileToolbar({ host, tabId, path, mode, canEdit = false, onModeChange, menu }: {
  host: TabHost; tabId: string; path: ReactNode;
  mode?: 'preview' | 'source'; canEdit?: boolean;
  onModeChange?: (mode: 'preview' | 'source') => void; menu: ReactNode;
}) {
  const { translate } = useSessionMessages();
  const pane = useContext(PaneContext)?.pane;
  const opener = pane?.openerOf(tabId);
  const returnsConversation = !!opener && !!pane?.registry.has(opener.kind) && !!pane.registry.get(opener.kind).conversation && (host.navigationOf(tabId)?.index ?? 0) === 0;
  const back = translate(returnsConversation ? 'tabs.backToConversation' : 'tabs.back');
  return <div role="toolbar" data-file-toolbar="" data-tab-content-toolbar="" className={`${panelHeaderBarClass} @container/file-toolbar min-w-0 justify-between gap-2`}>
    <div className="flex shrink-0 items-center gap-1">
      {host.canGo(tabId, -1) ? <Button size="sm" variant="ghost" className="gap-1 text-xs" aria-label={back} title={back} data-testid={returnsConversation ? 'tab-return-conversation' : undefined} onClick={() => void host.go(tabId, -1)}><ArrowLeft className="size-3.5" /><span className="@max-[420px]/file-toolbar:sr-only">{back}</span></Button> : null}
    </div>
    {path}
    <div className="flex shrink-0 items-center gap-1">
      {mode && (mode === 'preview'
        ? <Button size="icon-sm" variant="outline" aria-label={translate('tabs.edit')} title={translate('tabs.edit')} disabled={!canEdit} onClick={() => onModeChange?.('source')}><Pencil className="size-3.5" /></Button>
        : <Button size="icon-sm" variant="outline" aria-label={translate('tabs.read')} title={translate('tabs.read')} onClick={() => onModeChange?.('preview')}><Eye className="size-3.5" /></Button>)}
      {menu}
    </div>
  </div>;
});
