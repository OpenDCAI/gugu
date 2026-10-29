import { messageForUser } from '@/lib/userFacingError';
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';
import { commandRegistry } from '@renderer/lib/commands/registry';
import { useCommandProvider } from '@renderer/lib/commands/use-command-provider';
import { ChevronDown, SquareArrowRight } from '@/lib/icons'
import React, { useCallback, useContext, useMemo } from 'react';
import { PageShownContext } from '@renderer/app/recent-session-pages';
import { useScreenBlock } from '@renderer/app/screen-block-context';
import { useToast } from '@renderer/lib/hooks/use-toast';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { useOpenInApps } from '@renderer/lib/hooks/useOpenInApps';
import { rpc } from '@renderer/lib/ipc';
import { ContextMenuItem } from '@renderer/lib/ui/context-menu';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@renderer/lib/ui/select';
import { BoundShortcut } from '@renderer/lib/ui/shortcut';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { cn } from '@renderer/utils/utils';
import { isValidOpenInAppId, type OpenInAppId } from '@shared/openInApps';

interface OpenInMenuProps {
  path: string;
  className?: string;
  borderless?: boolean;
}

/**
 * 「在哪里打开」这个路径能用的那几个 app,和打开它的那一下:页签条上这颗分裂按钮,和项目页签右键菜单里那几行
 * (gugu-dev#181)读同一份,❌ 各写一份。`menuApps` 默认的那个排在最前。
 */
export function useOpenInTargets(path: string) {
  const { toast } = useToast();
  const { translate } = useSessionMessages();
  const { icons, labels, installedApps, availability, loading } = useOpenInApps();
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

  const sortedApps = useMemo(() => {
    if (!defaultApp) return installedApps;
    return [...installedApps].sort((a, b) => {
      if (a.id === defaultApp) return -1;
      if (b.id === defaultApp) return 1;
      return 0;
    });
  }, [defaultApp, installedApps]);

  const menuApps = useMemo(
    () => sortedApps.filter((app) => !app.hideIfUnavailable || availability[app.id]),
    [availability, sortedApps]
  );

  return { icons, labels, availability, loading, defaultApp, menuApps, triggerOpenIn, selectAndOpenApp };
}

export const OpenInMenu: React.FC<OpenInMenuProps> = ({
  path,
  className,
  borderless = false,
}) => {
  const { translate } = useSessionMessages();
  const { icons, labels, availability, loading, defaultApp, menuApps, triggerOpenIn, selectAndOpenApp } = useOpenInTargets(path);

  // Listens on the document: only the page on screen answers (@@@retained-session-pages), and of the
  // blocks on the screen only the one looked at (#7052).
  const pageShown = useContext(PageShownContext);
  const { focused: blockFocused } = useScreenBlock();
  const shown = pageShown && blockFocused;
  const buttonAppId = useMemo(() => {
    if (defaultApp && menuApps.some((app) => app.id === defaultApp)) {
      return defaultApp;
    }
    return menuApps[0]?.id;
  }, [defaultApp, menuApps]);

  const buttonAppLabel = buttonAppId ? (labels[buttonAppId] ?? buttonAppId) : null;

  useCommandProvider({
    scopeId: 'project',
    getCommands: () => !shown || !buttonAppId || loading ? [] : [{
      id: 'project.openInEditor', execute: () => { void triggerOpenIn(buttonAppId); },
    }],
  });

  const renderOpenButton = (nativeDisabled: boolean) => (
    <button
      type="button"
      className={cn(
        'group flex min-w-0 flex-1 items-center w-full border-r border-border rounded-r-none px-2 text-xs transition-colors hover:bg-row-hover active:bg-row-press hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50',
        borderless && 'border-none  pr-1'
      )}
      onClick={() => {
        if (loading || !buttonAppId) return;
        commandRegistry.dispatch('project.openInEditor');
      }}
      disabled={nativeDisabled || undefined}
      aria-disabled={buttonAppId ? undefined : true}
      data-open-in-primary=""
      aria-label={
        buttonAppLabel ? translate('titlebar.openIn', { app: buttonAppLabel }) : translate('titlebar.open')
      }
    >
      {/* @@@open-in-trigger-glyph — 常驻位是**单色线图**,不是目标 app 的原生彩色图标。
          behavior session-page「视觉」写死了「素雅零装饰:细边框、系统字、线性图标」,而这一横排
          另外四枚都是单色线图 —— 一枚彩色 PNG 混在里面,眼睛先看到它,读不成一排(owner
          2026-09-07 拍)。
          「会用哪个 app 打开」这个事实没有丢,只是换了地方:下面 SelectContent 里每一条仍然带
          着该 app 的彩色图标,tooltip 与 aria-label 也都点名到 app。彩色退进菜单,常驻位留线图。 */}
      <SquareArrowRight className="size-4" />
    </button>
  );

  return (
    <div
      className={cn(
        'border border-border rounded-md h-7 flex items-center text-foreground-muted overflow-hidden',
        borderless && 'border-none',
        className
      )}
    >
      <TooltipProvider delay={0}>
        <Tooltip>
          {buttonAppId ? (
            <TooltipTrigger render={<span className="inline-flex min-w-0 flex-1 self-stretch" />}>
              {renderOpenButton(loading)}
            </TooltipTrigger>
          ) : (
            <TooltipTrigger render={renderOpenButton(false)} />
          )}
          <TooltipContent side="bottom">
            <div className="flex flex-col gap-1">
              <span>
                {translate('titlebar.openIn', {
                  app: buttonAppLabel || translate('titlebar.openInFallback'),
                })}
              </span>
              <BoundShortcut commandId="project.openInEditor" variant="keycaps" />
            </div>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <Select
        value={defaultApp ?? undefined}
        onValueChange={(value) => {
          if (isValidOpenInAppId(value)) {
            selectAndOpenApp(value as OpenInAppId);
          }
        }}
      >
        <Tooltip>
          <TooltipTrigger
            render={
              <SelectTrigger
                showChevron={false}
                className="group flex size-7 shrink-0 items-center justify-center border-none bg-transparent transition-colors hover:bg-row-hover hover:text-foreground"
                aria-label={translate('titlebar.openWithOptions')}
              >
                {/* 16px 与容器规则(index.css @@@titlebar-action-icons)同值。这里仍要显式写:
                    OpenInMenu 还挂在文件工具条与草稿面板上,那两处够不到容器规则,
                    留空会掉回图标组件 size=24 的默认值。 */}
                <ChevronDown className="size-4" />
              </SelectTrigger>
            }
          ></TooltipTrigger>
          <TooltipContent side="bottom">{translate('titlebar.chooseHowToOpen')}</TooltipContent>
        </Tooltip>
        <SelectContent align="end" alignItemWithTrigger={false} sideOffset={6} className="w-max">
          {menuApps.map((app) => {
            const isAvailable = loading
              ? availability[app.id] === true
              : availability[app.id] !== false;
            return (
              <SelectItem key={app.id} value={app.id} disabled={!isAvailable}>
                {icons[app.id] && <OpenInAppIcon src={icons[app.id]} monochrome={app.monochrome} alt={labels[app.id] || app.label} />}
                {labels[app.id] || app.label}
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
    </div>
  );
};

/**
 * 「在 X 中打开」那几行,摆进一个右键菜单里(项目页签,gugu-dev#181):和上面那颗分裂按钮同一份 app、同一下打开。
 * `targets` 由菜单的主人(一直挂着的页签)读:菜单打开时这台机器装了哪些 app 已经知道,❌ 先铺一排灰的再缩回去。
 */
export function OpenInMenuItems({ targets }: { targets: ReturnType<typeof useOpenInTargets> }) {
  const { translate } = useSessionMessages();
  const { icons, labels, availability, loading, menuApps, selectAndOpenApp } = targets;
  if (loading) return null;
  return (
    <>
      {menuApps.map((app) => {
        const isAvailable = availability[app.id] !== false;
        const label = labels[app.id] || app.label;
        return (
          <ContextMenuItem key={app.id} className="flex items-center gap-2" disabled={!isAvailable} onClick={() => selectAndOpenApp(app.id)}>
            {icons[app.id] ? (
              <OpenInAppIcon src={icons[app.id]} monochrome={app.monochrome} alt="" />
            ) : (
              <span className="size-4" />
            )}
            {translate('titlebar.openIn', { app: label })}
          </ContextMenuItem>
        );
      })}
    </>
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
