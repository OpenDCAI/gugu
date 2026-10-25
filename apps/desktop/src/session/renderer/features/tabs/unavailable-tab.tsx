import { messageForUser } from '@/lib/userFacingError';
import { Unplug, X } from '@/lib/icons'
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import { installedExtensionsStore } from '@renderer/features/extensions/installed-extensions-store';
import { toast } from '@renderer/lib/hooks/use-toast';
import { Button } from '@renderer/lib/ui/button';
import { Spinner } from '@renderer/lib/ui/spinner';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { log } from '@renderer/utils/logger';
import { localizedManifestText } from '@shared/extensions/catalog';
import { parseExtensionTabKind } from '@shared/extensions/manifest';
import type { ResolvedTab, TabResource } from './core/tab-provider';
import type { TabHost } from './core/tab-host';
import { GenericTabDragPreview, GenericTabItem } from './tab-bar/generic-tab-item';

const UNAVAILABLE_TAB_RESOURCE = Symbol('unavailable-tab-resource');

export type UnavailableTabResource = TabResource & {
  readonly [UNAVAILABLE_TAB_RESOURCE]: true;
};

export function createUnavailableTabResource(): UnavailableTabResource {
  return {
    [UNAVAILABLE_TAB_RESOURCE]: true,
    dispose() {},
  };
}

export function isUnavailableTabResource(
  resource: TabResource
): resource is UnavailableTabResource {
  return UNAVAILABLE_TAB_RESOURCE in resource;
}

export function UnavailableTabBarItem({ tab, host }: { tab: ResolvedTab; host: TabHost }) {
  const { translate } = useSessionMessages();
  return (
    <GenericTabItem
      tab={tab}
      host={host}
      ctx={host.ctx}
      label={translate('tabs.unavailableLabel', { kind: tab.kind })}
      tooltip={translate('tabs.unavailableTooltip', { kind: tab.kind })}
      preSlot={<Unplug className="size-4 shrink-0 text-foreground-passive" />}
      hasError
    />
  );
}

export function UnavailableTabDragPreview({ tab }: { tab: ResolvedTab }) {
  const { translate } = useSessionMessages();
  return (
    <GenericTabDragPreview
      label={translate('tabs.unavailableLabel', { kind: tab.kind })}
      preSlot={<Unplug className="size-4 text-foreground-passive" />}
    />
  );
}

export function UnavailableTabContent({ tab, host }: { tab: ResolvedTab; host: TabHost }) {
  return (
    <UnavailableTabPlaceholder kind={tab.kind} onClose={() => host.requestCloseTab(tab.tabId)} />
  );
}

/**
 * The placeholder itself, without the engine around it.
 *
 * Split out because the draft workspace panel keeps its own tab list and never asks the
 * registry — so an extension uninstalled while a draft tab is open would keep drawing
 * there even after the engine stopped drawing it elsewhere. Two surfaces showing
 * different things for the same situation is how they drift; one component is how they
 * cannot. Refs #2374.
 *
 * Two situations land here and they must not read the same (#5265, owner:「如果扩展
 * 还在被其他 tab 页面上使用,但是我们把他移除了」): an extension that is *gone* (or a
 * kind nothing provides) says so and offers Close; an extension that is installed but
 * *not enabled* — the person just removed it from the panel while this tab was open —
 * says which one, that enabling brings the tab back in place, and offers exactly that.
 */
export const UnavailableTabPlaceholder = observer(function UnavailableTabPlaceholder({
  kind,
  onClose,
}: {
  kind: string;
  onClose: () => void;
}) {
  const { translate, locale } = useSessionMessages();
  const [enabling, setEnabling] = useState(false);
  const parsed = parseExtensionTabKind(kind);
  const manifest = parsed ? installedExtensionsStore.manifestFor(parsed.extensionId) : undefined;
  const notEnabled = manifest !== undefined && !installedExtensionsStore.isEnabled(manifest.id);
  /** 会话类的标签页(会话页聊天 / 终端)——它们不是扩展，落到这一屏时文案要另说一句。 */
  const isSessionKind = kind === 'session' || kind === 'acp-chat' || kind === 'side-chat';

  const enable = async () => {
    if (!manifest || enabling) return;
    setEnabling(true);
    try {
      // Loaded on the click, not at module load: this placeholder sits under the
      // tab engine, and a static import here drags the whole extension-tab graph
      // (registry → providers → app state, which opens IPC on construction) into
      // every surface that can show a placeholder — CI saw it as unhandled IPC
      // errors in an unrelated titlebar test.
      const { setExtensionEnabled } = await import(
        '@renderer/features/extensions/set-extension-enabled'
      );
      // The provider registers again and PaneStore promotes this very tab in place.
      await setExtensionEnabled(manifest, true);
    } catch (error) {
      log.error('extension enable refused:', error);
      toast({
        title: translate('extensions.switchFailed'), description: messageForUser(error),
        tier: 'error',
        action: { label: translate('extensions.retry'), onClick: () => void enable() },
      });
    } finally {
      setEnabling(false);
    }
  };

  return (
    <div
      data-testid="unavailable-tab-placeholder"
      data-tab-kind={kind}
      data-reason={notEnabled ? 'not-enabled' : 'unavailable'}
      className="flex h-full w-full flex-col items-center justify-center p-8"
    >
      <div className="flex max-w-md flex-col items-center gap-3 text-center">
        <Unplug className="size-6 text-foreground-passive" />
        <p className="font-sans text-sm font-medium text-foreground">
          {notEnabled
            ? translate('tabs.notEnabledTitle', { name: localizedManifestText(manifest, locale).name })
            : translate('tabs.unavailableTitle')}
        </p>
        <p className="text-xs text-foreground-passive">
          {notEnabled
            ? translate('tabs.notEnabledDescription')
            : isSessionKind
              ? /* 会话标签页落到这一屏说的是「它的提供方还没注册」（快照恢复期、provider 注销），
                   ❌ 不是「某个扩展不可用」—— 扩展语境那句话对着一条会话是错的文案
                   （spec `session-always-openable`：出错也不许乱说话）。 */
                translate('tabs.sessionUnavailableDescription')
              : translate('tabs.unavailableDescription', { kind })}
        </p>
        <div className="flex items-center gap-2">
          {notEnabled && (
            <Button size="sm" disabled={enabling} onClick={() => void enable()}>
              {enabling && <Spinner className="size-3" />}
              {translate(enabling ? 'tabs.enabling' : 'tabs.enableExtension')}
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={onClose}>
            <X />
            {translate('tabs.unavailableClose')}
          </Button>
        </div>
      </div>
    </div>
  );
});
