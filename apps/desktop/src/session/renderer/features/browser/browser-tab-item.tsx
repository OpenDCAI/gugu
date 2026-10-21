import { LoadingIndicator } from '@/lib/loading/LoadingIndicator'
import { Globe } from '@/lib/icons'
import { observer } from 'mobx-react-lite';
import type { TabBarItemProps, ResolvedTab } from '@renderer/features/tabs/core/tab-provider';
import {
  GenericTabDragPreview,
  GenericTabItem,
} from '@renderer/features/tabs/tab-bar/generic-tab-item';
import type { ProjectsTranslate } from '@renderer/localization/messages-projects';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import type { BrowserSessionSnapshot } from '@shared/browser';
import { fileTabLabels } from '@renderer/features/sessions/editor/file-tab-label';
import { fileBaseName } from '@renderer/features/sessions/stores/workspace-path';
import type { BrowserTabResource } from './browser-tab-resource';

/** file: 网页在盘上的路径(没有标题时叫它的文件名、同名的靠它补区分路径);别的网页没有。 */
function pagePath(url: string | undefined): string {
  if (!url?.startsWith('file:')) return '';
  try {
    return decodeURIComponent(new URL(url).pathname);
  } catch {
    return '';
  }
}

// The page title and host are raw page data; only the "no page yet" stand-in
// is localized.
function browserTabLabel(
  session: BrowserSessionSnapshot | undefined,
  translate: ProjectsTranslate
): string {
  if (!session) return translate('browser.tabFallbackTitle');
  if (session.currentUrl === 'about:blank') return translate('browser.tabFallbackTitle');
  if (session.title.trim()) return session.title.trim();
  try {
    // file: 网页没有 host:退回文件名,❌ 空串(打不开的 file: 页,页签上一个字都没有)。
    return new URL(session.currentUrl).host || fileBaseName(pagePath(session.currentUrl)) || translate('browser.tabFallbackTitle');
  } catch {
    return translate('browser.tabFallbackTitle');
  }
}

export const BrowserTabBarItem = observer(function BrowserTabBarItem({
  tab,
  host,
  ctx,
}: TabBarItemProps<BrowserTabResource>) {
  const { translate } = useSessionMessages();
  const session = tab.resource.session;
  // 两个目录下各一个没有 title 的 index.html:与文件页签同一条规矩,补上区分它们的那截路径(file-tab-label.ts)。
  const browserTabs = host.resolvedTabs.filter((t): t is ResolvedTab<BrowserTabResource> => t.kind === 'browser');
  const { name: label, hint } = fileTabLabels(
    browserTabs.map((t) => ({ path: pagePath(t.resource.session?.currentUrl), title: browserTabLabel(t.resource.session, translate) }))
  )[browserTabs.findIndex((t) => t.tabId === tab.tabId)] ?? { name: browserTabLabel(session, translate) };

  return (
    <GenericTabItem
      tab={tab}
      host={host}
      ctx={ctx}
      label={label}
      hint={hint}
      preSlot={
        <span className="shrink-0 text-foreground-muted [&>svg]:h-3 [&>svg]:w-3">
          {session?.isLoading ? <LoadingIndicator size="inline" /> : <Globe />}
        </span>
      }
      hasError={!!session?.loadError}
    />
  );
});

export function BrowserTabBarItemDragPreview({ tab }: { tab: ResolvedTab<BrowserTabResource> }) {
  const { translate } = useSessionMessages();
  const label = browserTabLabel(tab.resource.session, translate);
  return (
    <GenericTabDragPreview
      preSlot={<Globe className="size-3 shrink-0 text-foreground-muted" />}
      label={label}
    />
  );
}
