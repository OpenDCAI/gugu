import { useContext, type ReactNode } from 'react';
import { observer } from 'mobx-react-lite';
import { ArrowLeft, ArrowRight } from '@/lib/icons';
import { PaneContext } from '@renderer/features/tabs/pane-context';
import type { TabHost } from '@renderer/features/tabs/core/tab-host';
import { Button } from '@renderer/lib/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@renderer/lib/ui/toggle-group';
import { panelHeaderBarClass } from '@renderer/lib/ui/panel-header-bar';
import { useSessionMessages } from '@renderer/localization/use-session-messages';

/** One file toolbar for working-copy files and the host's read-only chat-file preview. */
export const FileToolbar = observer(function FileToolbar({ host, tabId, path, mode, canEdit = false, onModeChange, menu }: {
  host: TabHost; tabId: string; path: ReactNode;
  mode?: 'preview' | 'source'; canEdit?: boolean;
  onModeChange?: (mode: 'preview' | 'source') => void; menu: ReactNode;
}) {
  const { translate } = useSessionMessages();
  const pane = useContext(PaneContext)?.pane;
  const entry = pane?.entries.get(tabId);
  const opener = entry?.openerTabId ? pane?.entries.get(entry.openerTabId) : undefined;
  const returnsConversation = !!opener && !!pane?.registry.has(opener.kind) && !!pane.registry.get(opener.kind).conversation && (host.navigationOf(tabId)?.index ?? 0) === 0;
  const back = translate(returnsConversation ? 'tabs.backToConversation' : 'tabs.back');
  return <div role="toolbar" data-file-toolbar="" data-tab-content-toolbar="" className={`${panelHeaderBarClass} min-w-0 justify-between gap-2`}>
    <div className="flex shrink-0 items-center gap-1">
      <Button size="sm" variant="ghost" className="gap-1 text-xs" aria-label={back} title={back} data-testid={returnsConversation ? 'tab-return-conversation' : undefined} disabled={!host.canGo(tabId, -1)} onClick={() => void host.go(tabId, -1)}><ArrowLeft className="size-3.5" />{back}</Button>
      <Button size="icon-sm" variant="ghost" aria-label={translate('tabs.forward')} title={translate('tabs.forward')} disabled={!host.canGo(tabId, 1)} onClick={() => void host.go(tabId, 1)}><ArrowRight className="size-3.5" /></Button>
    </div>
    {path}
    <div className="flex shrink-0 items-center gap-1">
      {mode && <ToggleGroup size="sm" multiple={false} value={[mode]} onValueChange={([value]) => { if (value === 'preview' || (value === 'source' && canEdit)) onModeChange?.(value); }}>
        <ToggleGroupItem value="preview" className="text-xs" aria-label={translate('tabs.read')} title={translate('tabs.read')}>{translate('tabs.read')}</ToggleGroupItem>
        <ToggleGroupItem value="source" disabled={!canEdit} className="text-xs" aria-label={translate('tabs.edit')} title={translate('tabs.edit')}>{translate('tabs.edit')}</ToggleGroupItem>
      </ToggleGroup>}
      {menu}
    </div>
  </div>;
});
