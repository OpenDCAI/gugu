import { messageForUser } from '@/lib/userFacingError';
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';
import { SquareArrowRight } from '@/lib/icons'
import { useCallback } from 'react';
import { useToast } from '@renderer/lib/hooks/use-toast';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { useOpenInApps } from '@renderer/lib/hooks/useOpenInApps';
import { rpc } from '@renderer/lib/ipc';
import { MenuFold, MenuItem } from '@/components/ui/Menu';
import { isValidOpenInAppId, type OpenInAppId } from '@shared/openInApps';

/**
 * 「在哪里打开」这个路径能用的那几个 app,和打开它的那一下:项目页签右键菜单里那几行(gugu-dev#181)读它。
 */
export function useOpenInTargets(path: string) {
  const { toast } = useToast();
  const { translate } = useSessionMessages();
  const { icons, labels, menuApps, loading } = useOpenInApps();
  const { value: openIn, update } = useAppSettingsKey('openIn');

  const defaultApp: OpenInAppId | null =
    openIn?.default && isValidOpenInAppId(openIn.default) ? openIn.default : null;

  const persistPreferredApp = useCallback(
    (appId: OpenInAppId) => {
      update({ default: appId });
    },
    [update]
  );

  const triggerOpenIn = useCallback(
    async (appId: OpenInAppId) => {
      const label = labels[appId] || appId;
      try {
        const res = await rpc.app.openIn({
          app: appId,
          path,
        });
        if (!res?.success) {
          toast({
            title: translate('titlebar.openInFailed', { app: label }),
            description: messageForUser(res?.error),
            variant: 'destructive',
          });
        }
      } catch (e: unknown) {
        toast({
          title: translate('titlebar.openInFailed', { app: label }),
          description: messageForUser(e),
          variant: 'destructive',
        });
      }
    },
    [labels, path, toast, translate]
  );

  const selectAndOpenApp = useCallback(
    (appId: OpenInAppId) => {
      persistPreferredApp(appId);
      void triggerOpenIn(appId);
    },
    [persistPreferredApp, triggerOpenIn]
  );

  return { icons, labels, loading, defaultApp, menuApps, triggerOpenIn, selectAndOpenApp };
}

export function OpenInMenuItems({ targets }: { targets: ReturnType<typeof useOpenInTargets> }) {
  const { translate } = useSessionMessages();
  const { icons, labels, loading, menuApps, selectAndOpenApp } = targets;
  if (loading) return null;
  return (
    <MenuFold icon={<SquareArrowRight />} label={translate('titlebar.openWith')}>
      {menuApps.map((app) => {
        const label = labels[app.id] || app.label;
        return (
          <MenuItem key={app.id} icon={icons[app.id] ? <OpenInAppIcon src={icons[app.id]} monochrome={app.monochrome} alt="" /> : <span />} onClick={() => selectAndOpenApp(app.id)}>
            {translate('titlebar.openIn', { app: label })}
          </MenuItem>
        );
      })}
    </MenuFold>
  );
}

/** 「用…打开」那一排的应用图标。单色的(svg 填 currentColor)用遮罩画、底色取 currentColor:<img> 里的 currentColor 不认外面的文字色。 */
function OpenInAppIcon({ src, monochrome, alt }: { src: string | undefined; monochrome?: boolean; alt: string }) {
  if (!src) return null;
  if (!monochrome) return <img src={src} alt={alt} className="size-4 rounded-sm" />;
  return (
    <span
      role={alt ? 'img' : undefined}
      aria-label={alt || undefined}
      aria-hidden={alt ? undefined : true}
      className="inline-block size-4 shrink-0 bg-current"
      style={{ maskImage: `url(${src})`, maskSize: 'contain', maskRepeat: 'no-repeat', maskPosition: 'center' }}
    />
  );
}
