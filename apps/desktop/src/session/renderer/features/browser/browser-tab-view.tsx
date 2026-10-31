import { observer } from 'mobx-react-lite';
import { useContext, useEffect } from 'react';
import { PageShownContext } from '@renderer/app/recent-session-pages';
import { SshPromptCard } from '@/components/settings/addServer/SshPromptCard';
import '@/i18n/registerSettingsCatalog';
import { BrowserPane } from '@renderer/features/browser/browser-pane';
import { RemoteFloatingCard } from '@renderer/features/remote-hosts/remote-floating-card';
import type { ResolvedTab, TabContentProps } from '@renderer/features/tabs/core/tab-provider';
import { PairPlacementContext } from '@renderer/features/tabs/pair-placement-context';
import { rpc } from '@renderer/lib/ipc';
import type { BrowserTabResource } from './browser-tab-resource';
import { BrowserUrlResolverContext } from './browser-url-resolver';
import { RETAINED_SURFACE_HIDDEN_STYLE } from '@/lib/retainedSurface';

/**
 * Mounts BrowserPane for every open browser tab; visibility is managed via
 * visibility:hidden + inert so browser sessions survive tab switches.
 * When no browser tab is active, calls setActiveBrowser(null) so the browser
 * process stops responding to commands.
 */
export const TabContent = observer(function BrowserTabContent({ host }: TabContentProps) {
  const browserTabs = host.resolvedTabs.filter(
    (t): t is ResolvedTab<BrowserTabResource> => t.kind === 'browser'
  );
  // 并排时屏上有两枚(spec session-page「并排」):对话 + 网页时这里只有网页那一枚亮着;两个网页时两枚都亮着,
  // 各摆到自己那一半(PairPlacementContext)—— 两页的 <webview> 都不挪地方,❌ 挪进另一份内容重新加载。
  const placeInPair = useContext(PairPlacementContext);
  const anyShown = browserTabs.some((t) => t.isActive);
  // Session pages stay mounted while hidden (@@@retained-session-pages): only the page on screen
  // names the active browser, and it does so again whenever it comes back on screen.
  const pageActive = useContext(PageShownContext);

  useEffect(() => {
    if (!pageActive || anyShown) return;
    void rpc.browser.setActiveBrowser(null);
  }, [anyShown, pageActive]);

  return (
    <>
      {browserTabs.map((tab) => {
        const browserId = tab.resource.browserId;
        const visible = tab.isActive;
        const placement = visible && placeInPair ? placeInPair(tab.tabId) : null;
        // 点到这一页的工具栏(地址栏、后退)= 焦点到这一页;点进网页本身由主进程报(browserFocusedChannel)。
        const focusThis = placement && !tab.isFocused ? () => host.setActiveTab(tab.tabId) : undefined;
        // 不在屏上的那几枚照旧隐藏(#7274 网页本身是主进程的 view,隐藏的占位报 background,网页跟着收起;
        // agent 正在操作的那张由主进程让它收起着也照常出帧,这里不用再做透明那一套)。
        return (
          <div
            key={browserId}
            className="absolute"
            style={visible ? (placement ?? { inset: 0 }) : RETAINED_SURFACE_HIDDEN_STYLE}
            data-pane-tab={placement ? tab.tabId : undefined}
            onPointerDownCapture={focusThis}
            onFocusCapture={focusThis}
          >
            <BrowserTab resource={tab.resource} visible={visible && pageActive} focused={tab.isFocused ?? visible} />
          </div>
        );
      })}
    </>
  );
});

const BrowserTab = observer(function BrowserTab({
  resource,
  visible,
  focused,
}: {
  resource: BrowserTabResource;
  visible: boolean;
  focused: boolean;
}) {
  const attachment = resource.attachment;
  if (!attachment) return <BrowserPane browserId={resource.browserId} visible={visible} focused={focused} />;
  const pending = attachment.prompt;
  return (
    <BrowserUrlResolverContext.Provider value={attachment.resolve}>
      <div className="relative h-full">
        <BrowserPane browserId={resource.browserId} visible={visible} focused={focused} />
        {pending && (
          <RemoteFloatingCard testId="remote-browser-prompt" offsetClassName="top-14">
            <SshPromptCard
              prompt={pending.prompt}
              variant="floating"
              context={pending.context}
              cancellable
              onAnswer={(value, extra) => attachment.answer(value, extra)}
            />
          </RemoteFloatingCard>
        )}
      </div>
    </BrowserUrlResolverContext.Provider>
  );
});
