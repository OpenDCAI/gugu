import type { ReactNode } from 'react';
import { ResourceMenu } from '@/components/ResourceMenu';
import type { ResourceContext } from '@shared/resource-actions';
import { Switch } from '@renderer/lib/ui/switch';
import { cn } from '@renderer/utils/utils';
import type { SessionTranslate } from '../extension-consent';
import { AppLifecycleButton, type AppLifecycle } from './app-lifecycle-button';
import { AppMoreMenu } from './app-more-menu';
import { ExtensionMonogram } from './extension-monogram';
import type { ExtensionPendingAction } from './extension-pending';

/**
 * 市场里的一行(owner 10-19「参考 app store 首页」= App Store 的 App 行):图标、名字、名字下面那一句、右边那颗按钮。
 * 状态只在按钮上(安装 / 下载进度 / 打开 / 更新 / 装不了的原因),名字下面那一句只说这个 App 是什么(副标题,没写取简介第一句)。
 * 点这一行别处 = 它的产品页;名字是一颗按钮,键盘也能进产品页(点了冒泡到这一行)。
 */
export function MarketAppRow({
  id,
  name,
  subtitle,
  iconUrl,
  deprecated = false,
  lifecycle,
  pending,
  pendingPercent,
  translate,
  onOpen,
  onAction,
  resource,
}: {
  id: string;
  name: string;
  subtitle: string;
  iconUrl?: string | null;
  deprecated?: boolean;
  lifecycle: AppLifecycle;
  pending?: ExtensionPendingAction;
  pendingPercent?: number;
  translate: SessionTranslate;
  onOpen: () => void;
  onAction: () => void;
  resource?: ResourceContext;
}) {
  return (
    <ResourceMenu resource={resource ?? { kind: 'app', target: { kind: 'app-detail', extensionId: id } }}><div
      role="listitem"
      className={cn('mk-lockup', pending && 'is-busy')}
      data-testid={`extension-card-${id}`}
      aria-busy={pending ? 'true' : undefined}
      onClick={onOpen}
    >
      {/* 图标是下载站上的公开地址,滚到才取、浏览器自己缓存 —— 清单不带图标字节。 */}
      <span className="mk-icon is-64">
        <ExtensionMonogram name={name} iconDataUrl={iconUrl} />
      </span>
      <span className="mk-lockup-body">
        <span className="mk-lockup-tx">
          <button type="button" className={cn('mk-lockup-name', deprecated && 'is-deprecated')} aria-label={translate('extensions.detailsOf', { name })}>
            {name}
          </button>
          <span className="mk-lockup-sub">{subtitle}</span>
        </span>
        <AppLifecycleButton
          state={lifecycle}
          pending={pending}
          percent={pendingPercent}
          translate={translate}
          onClick={onAction}
          testId={`market-row-action-${id}`}
        />
      </span>
    </div></ResourceMenu>
  );
}

/**
 * 已安装的一行(#7059,原型「每行一个开关和 ⋯」):图标、名字和版本、一句(有新版 / 撤回 / 程序没起来 / 收回了几项 / 简介),
 * 右边那颗按钮(启用着才有:打开 / 更新)、开关、⋯。点这一行 = 它的产品页;权限、给哪些 agent 都在那一页。
 */
export function InstalledAppRow({
  id,
  name,
  version,
  line,
  iconUrl,
  enabled,
  switching = false,
  lifecycle,
  pending,
  pendingPercent,
  docked,
  translate,
  onOpen,
  onAction,
  onToggleEnabled,
  menu,
}: {
  id: string;
  name: string;
  version: string;
  line: ReactNode;
  iconUrl?: string;
  enabled: boolean;
  switching?: boolean;
  lifecycle: AppLifecycle;
  pending?: ExtensionPendingAction;
  pendingPercent?: number;
  docked: boolean;
  translate: SessionTranslate;
  onOpen: () => void;
  onAction: () => void;
  /** 预装的没有:咕咕自己的,停不了也卸不了(preinstalled-apps.ts)。 */
  onToggleEnabled?: (enabled: boolean) => void;
  menu: {
    resource?: ResourceContext;
    onToggleDock?: () => void;
    onOpenInWindow?: () => void;
    onForward?: () => void;
    onUninstall?: () => void;
  };
}) {
  return (
    <ResourceMenu resource={menu.resource ?? { kind: 'app', target: { kind: 'app-detail', extensionId: id } }}><li
      className={cn('mk-row', !enabled && 'is-off', pending && 'is-busy')}
      data-testid={`extension-row-${id}`}
      aria-busy={pending || switching ? 'true' : undefined}
      onClick={onOpen}
    >
      <span className="mk-icon">
        <ExtensionMonogram name={name} iconDataUrl={iconUrl} />
      </span>
      <div className="mk-tx">
        <b>
          <button type="button" className="mk-name text-left" aria-label={translate('extensions.detailsOf', { name })}>
            {name}
          </button>
          <em>v{version}</em>
        </b>
        {line}
      </div>
      {enabled ? (
        <AppLifecycleButton
          state={lifecycle}
          pending={pending}
          percent={pendingPercent}
          translate={translate}
          onClick={onAction}
          testId={`extension-row-action-${id}`}
        />
      ) : pending ? (
        <AppLifecycleButton state={null} pending={pending} percent={pendingPercent} translate={translate} onClick={onAction} />
      ) : null}
      {/* 开关自己一格:点它只开关,❌ 顺带开产品页;预装的没有开关,格子照样占着。 */}
      <span className="mk-switch-slot" onClick={(event) => event.stopPropagation()}>
        {onToggleEnabled ? (
          <Switch
            size="sm"
            checked={enabled}
            disabled={switching || pending !== undefined}
            aria-busy={switching ? 'true' : undefined}
            aria-label={translate('extensions.switchLabel', { name })}
            title={translate(enabled ? 'extensions.switchedOn' : 'extensions.switchedOff')}
            onCheckedChange={onToggleEnabled}
          />
        ) : null}
      </span>
      <AppMoreMenu
        name={name}
        enabled={enabled}
        docked={docked}
        disabled={pending !== undefined}
        translate={translate}
        {...menu}
        onToggleEnabled={onToggleEnabled}
        testId={`extension-row-more-${id}`}
      />
    </li></ResourceMenu>
  );
}
