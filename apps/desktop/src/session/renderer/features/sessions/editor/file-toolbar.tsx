import { useContext, type ReactNode } from 'react';
import { observer } from 'mobx-react-lite';
import { ArrowLeft, ArrowRight, Eye, Pencil } from '@/lib/icons';
import { PaneContext } from '@renderer/features/tabs/pane-context';
import type { TabHost } from '@renderer/features/tabs/core/tab-host';
import { Button } from '@renderer/lib/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@renderer/lib/ui/toggle-group';
import { panelHeaderBarClass } from '@renderer/lib/ui/panel-header-bar';
import { useSessionMessages } from '@renderer/localization/use-session-messages';

/**
 * One file toolbar for working-copy files and the host's read-only chat-file preview. Left to right: back (with its words
 * when there is room), forward, the file's name, the mode, ⋯ — the order the folder App's own head keeps too (viewer-unify).
 * Narrowing, it gives way in that order: back's words, the mode's words (their icons stay), forward; the name last.
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
      <Button size="sm" variant="ghost" className="gap-1 text-xs" aria-label={back} title={back} data-testid={returnsConversation ? 'tab-return-conversation' : undefined} disabled={!host.canGo(tabId, -1)} onClick={() => void host.go(tabId, -1)}><ArrowLeft className="size-3.5" /><span className="@max-[420px]/file-toolbar:sr-only">{back}</span></Button>
      <Button size="icon-sm" variant="ghost" aria-label={translate('tabs.forward')} title={translate('tabs.forward')} disabled={!host.canGo(tabId, 1)} onClick={() => void host.go(tabId, 1)} className="@max-[320px]/file-toolbar:hidden"><ArrowRight className="size-3.5" /></Button>
    </div>
    {path}
    <div className="flex shrink-0 items-center gap-1">
      {mode && <ToggleGroup size="sm" multiple={false} value={[mode]} onValueChange={([value]) => { if (value === 'preview' || (value === 'source' && canEdit)) onModeChange?.(value); }}>
        <ToggleGroupItem value="preview" className="text-xs" aria-label={translate('tabs.read')} title={translate('tabs.read')}><Eye className="hidden size-3.5 @max-[420px]/file-toolbar:block" /><span className="@max-[420px]/file-toolbar:sr-only">{translate('tabs.read')}</span></ToggleGroupItem>
        <ToggleGroupItem value="source" disabled={!canEdit} className="text-xs" aria-label={translate('tabs.edit')} title={translate('tabs.edit')}><Pencil className="hidden size-3.5 @max-[420px]/file-toolbar:block" /><span className="@max-[420px]/file-toolbar:sr-only">{translate('tabs.edit')}</span></ToggleGroupItem>
      </ToggleGroup>}
      {menu}
    </div>
  </div>;
});
