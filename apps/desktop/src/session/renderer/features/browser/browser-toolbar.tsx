import { ArrowLeft, ArrowRight, Ellipsis, Globe, Plus, Reload, RotateCcw, Square } from '@/lib/icons'
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator'
import { Minus } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';
import type { ProjectsTranslate } from '@renderer/localization/messages-projects';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { rpc } from '@renderer/lib/ipc';
import { openShellSettings } from '@renderer/lib/open-shell-settings';
import { Button } from '@renderer/lib/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@renderer/lib/ui/dropdown-menu';
import { Input } from '@renderer/lib/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { cn } from '@renderer/utils/utils';
import {
  BROWSER_DEFAULT_URL,
  BROWSER_DEFAULT_ZOOM_FACTOR,
  BROWSER_ISOLATED_PROFILE_ID,
  DEFAULT_BROWSER_PROFILES,
  browserProfileLabel,
  canZoomIn,
  canZoomOut,
  formatBrowserZoomPercent,
  isDefaultBrowserZoomFactor,
  nextBrowserZoomFactor,
  normalizeBrowserUrl,
  previousBrowserZoomFactor,
  type BrowserSessionSnapshot,
} from '@shared/browser';
import { browserSessionStore } from './browser-session-store';
import {
  canOpenBrowserUrlExternally,
  captureBrowserScreenshot,
  clearBrowserData,
  confirmClearBrowserStorage,
  openBrowserUrlExternally,
} from './browser-toolbar-actions';
import { browserUrlInputText } from './browser-url-input';
import type { BrowserWebviewAdapter } from './browser-webview-types';
import { panelHeaderBarClass } from '@renderer/lib/ui/panel-header-bar';

// Selection is conveyed by the checkmark alone (matching SelectItem); the base
// radio item pins a background on the checked row and mutes unchecked rows.
const PROFILE_RADIO_ITEM_CLASS = 'text-foreground data-checked:bg-transparent';

export function BrowserToolbar({
  session,
  adapter,
  autoFocusUrl,
  onNavigate,
  onGoBack,
  onGoForward,
  onReload,
  onForceReload,
  onSetZoomFactor,
  onFitToWidth,
  onFocusUrl,
}: {
  session: BrowserSessionSnapshot;
  adapter: BrowserWebviewAdapter | null;
  autoFocusUrl?: boolean;
  onNavigate?: (url: string) => boolean;
  onGoBack?: () => void;
  onGoForward?: () => void;
  onReload?: () => void;
  onForceReload?: () => void;
  onSetZoomFactor?: (factor: number) => void;
  /** 「适应宽度」:把缩放交还给自动挡,按当前面板宽度把整幅页面装进来。 */
  onFitToWidth?: () => void;
  onFocusUrl?: (focus: () => void) => void;
}) {
  const [urlText, setUrlText] = useState(browserUrlInputText(session.currentUrl));
  const [urlError, setUrlError] = useState<string | null>(null);
  const [failedFaviconUrl, setFailedFaviconUrl] = useState<string | null>(null);
  const urlInputRef = useRef<HTMLInputElement | null>(null);
  const { translate } = useSessionMessages();
  const { value: browserSettings } = useAppSettingsKey('browser');
  const profiles = browserSettings?.profiles ?? DEFAULT_BROWSER_PROFILES;
  const profileLabel = browserProfileLabel(session.profileId, profiles);
  const faviconUrl =
    session.faviconUrl && session.faviconUrl !== failedFaviconUrl ? session.faviconUrl : null;

  useEffect(() => {
    setUrlText(browserUrlInputText(session.currentUrl));
  }, [session.currentUrl]);

  useEffect(() => {
    setFailedFaviconUrl(null);
  }, [session.faviconUrl]);

  useEffect(() => {
    onFocusUrl?.(() => {
      urlInputRef.current?.focus();
      urlInputRef.current?.select();
    });
  }, [onFocusUrl]);

  useEffect(() => {
    if (!autoFocusUrl) return;
    const timer = window.setTimeout(() => {
      urlInputRef.current?.focus();
      urlInputRef.current?.select();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [autoFocusUrl]);

  const navigate = () => {
    navigateTo(urlText);
  };

  const navigateTo = (url: string) => {
    const normalized = normalizeBrowserUrl(url);
    if (!normalized.ok) {
      setUrlError(urlRejectionMessage(normalized.reason, translate));
      return;
    }
    setUrlError(null);
    setUrlText(normalized.url);
    onNavigate?.(normalized.url);
  };

  const openExternal = () => {
    openBrowserUrlExternally(session.currentUrl);
  };

  const openDevTools = () => {
    void rpc.browser.openDevTools(session.browserId);
  };

  const confirmClearStorage = () => {
    confirmClearBrowserStorage(session, adapter, profileLabel, translate);
  };

  const switchProfile = (profileId: string) => {
    if (profileId === session.profileId) return;
    browserSessionStore.setSessionProfile(session.browserId, profileId, profiles);
  };

  const takeScreenshot = () => {
    void captureBrowserScreenshot(session, translate);
  };

  const canOpenExternal = canOpenBrowserUrlExternally(session.currentUrl);
  const zoomFactor = session.zoomFactor;

  return (
    <div className={cn(panelHeaderBarClass, 'gap-1')}>
      <ToolbarIconButton
        label={translate('browser.back')}
        disabled={!adapter || !session.canGoBack}
        onClick={() => onGoBack?.()}
      >
        <ArrowLeft className="size-4" />
      </ToolbarIconButton>
      <ToolbarIconButton
        label={translate('browser.forward')}
        disabled={!adapter || !session.canGoForward}
        onClick={() => onGoForward?.()}
      >
        <ArrowRight className="size-4" />
      </ToolbarIconButton>
      <ToolbarIconButton
        label={translate(session.isLoading ? 'browser.stop' : 'browser.reload')}
        onClick={() => onReload?.()}
      >
        {session.isLoading ? <Square className="size-4" /> : <Reload className="size-4" />}
      </ToolbarIconButton>
      <form
        className="min-w-0 flex-1"
        onSubmit={(event) => {
          event.preventDefault();
          navigate();
        }}
      >
        <div className="relative">
          {faviconUrl ? (
            <img
              src={faviconUrl}
              alt=""
              className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 rounded-sm"
              draggable={false}
              onError={() => setFailedFaviconUrl(faviconUrl)}
            />
          ) : (
            <Globe className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-foreground-muted" />
          )}
          <Input
            ref={urlInputRef}
            value={urlText}
            onChange={(event) => {
              setUrlText(event.target.value);
              if (urlError) setUrlError(null);
            }}
            onFocus={(event) => event.currentTarget.select()}
            className="h-7 truncate border-0 pr-8 pl-7 text-sm shadow-none hover:border-0 focus-visible:border-0 focus-visible:ring-0"
            aria-label={translate('browser.urlLabel')}
            placeholder={translate('browser.urlPlaceholder')}
            spellCheck={false}
            autoCapitalize="none"
          />
          {session.isLoading && (
            <span className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-foreground-muted">
              <LoadingIndicator size="inline" />
            </span>
          )}
        </div>
        {urlError && (
          <div className="sr-only" role="alert">
            {urlError}
          </div>
        )}
      </form>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7 shrink-0"
              aria-label={translate('browser.actions')}
            />
          }
        >
          <Ellipsis className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-56">
          <DropdownMenuItem
            disabled={session.currentUrl === BROWSER_DEFAULT_URL || session.isLoading}
            onClick={takeScreenshot}
          >
            {translate('browser.copyScreenshot')}
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!canOpenExternal} onClick={openExternal}>
            {translate('browser.openExternally')}
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!adapter} onClick={() => onForceReload?.()}>
            {translate('browser.forceReload')}
          </DropdownMenuItem>
          {import.meta.env.DEV && (
            <DropdownMenuItem onClick={openDevTools}>
              {translate('browser.openDevTools')}
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>{translate('browser.profile')}</DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="min-w-44">
              <DropdownMenuRadioGroup
                value={session.profileId}
                onValueChange={(value) => switchProfile(String(value))}
              >
                {profiles.map((profile) => (
                  <DropdownMenuRadioItem
                    key={profile.id}
                    value={profile.id}
                    className={PROFILE_RADIO_ITEM_CLASS}
                  >
                    {profile.name}
                  </DropdownMenuRadioItem>
                ))}
                <DropdownMenuRadioItem
                  value={BROWSER_ISOLATED_PROFILE_ID}
                  className={PROFILE_RADIO_ITEM_CLASS}
                >
                  {translate('browser.isolatedPerTask')}
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => openShellSettings('browser')}>
                {translate('browser.manageProfiles')}
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSeparator />
          <div className="flex items-center justify-between gap-2 px-2 py-1.5 text-sm">
            <span>{translate('browser.zoom')}</span>
            <div className="flex items-center gap-1">
              <div className="flex items-center rounded-md bg-background-quaternary-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-6"
                  aria-label={translate('browser.zoomOut')}
                  disabled={!canZoomOut(zoomFactor)}
                  onClick={() => onSetZoomFactor?.(previousBrowserZoomFactor(zoomFactor))}
                >
                  <Minus className="size-3.5" />
                </Button>
                <span className="min-w-11 text-center text-xs text-foreground-muted tabular-nums">
                  {formatBrowserZoomPercent(zoomFactor)}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-6"
                  aria-label={translate('browser.zoomIn')}
                  disabled={!canZoomIn(zoomFactor)}
                  onClick={() => onSetZoomFactor?.(nextBrowserZoomFactor(zoomFactor))}
                >
                  <Plus className="size-3.5" />
                </Button>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-6"
                aria-label={translate('browser.resetZoom')}
                disabled={isDefaultBrowserZoomFactor(zoomFactor)}
                onClick={() => onSetZoomFactor?.(BROWSER_DEFAULT_ZOOM_FACTOR)}
              >
                <RotateCcw className="size-3.5" />
              </Button>
            </div>
          </div>
          {/* 老式桌面页(没有 `<meta name="viewport">`)在窄面板里会按自己的最小宽度排,右边被裁掉 ——
              这一项把整幅页面缩进面板,和手机浏览器打开这类页面是同一件事。为什么判据是 viewport meta
              而不是「内容比视口宽」,见 browser-page-fit.ts。
              它同时是**退出手动缩放**的出口:调过缩放之后自动适应就不再插手,点这里交还给自动挡。 */}
          <DropdownMenuItem disabled={!adapter} onClick={() => onFitToWidth?.()}>
            {translate('browser.fitToWidth')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={!adapter}
            onClick={() => clearBrowserData(session, 'cookies', () => adapter?.reload(), translate)}
          >
            {translate('browser.clearCookies')}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!adapter}
            onClick={() =>
              clearBrowserData(session, 'cache', () => adapter?.reloadIgnoringCache(), translate)
            }
          >
            {translate('browser.clearCache')}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={confirmClearStorage}>
            {translate('browser.clearStorage')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function ToolbarIconButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7 shrink-0"
            disabled={disabled}
            aria-label={label}
            onClick={onClick}
          >
            {children}
          </Button>
        }
      />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

// The normalizer's rejection reason is a protocol enum; it is mapped to copy
// only here, at the render boundary.
function urlRejectionMessage(reason: string, translate: ProjectsTranslate): string {
  if (reason === 'empty') return translate('browser.urlRejected.empty');
  if (reason === 'unsupported-file-url') return translate('browser.urlRejected.fileUrl');
  if (reason === 'unsupported-protocol') return translate('browser.urlRejected.protocol');
  return translate('browser.urlRejected.invalid');
}
